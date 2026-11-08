import { basename, isAbsolute } from 'node:path';
import { fileNameOf, MAX_MEDIA_BYTES, type MediaMime, mediaMimeOf } from '@jian/contracts';
import { openToRead } from '../agent/workspace.js';
import { bareAddress } from '../channels/email/text.js';
import { GatewayError } from '../core/errors.js';
import { stableUuid } from '../core/ids.js';
import { findMedia } from '../media/repository.js';
import type { Queryable } from '../storage/database.js';
import { mediaAssets } from '../storage/schema.js';

/** As many addresses as one email copies, each one a recipient the owner sees on the card. */
export const MAX_EMAIL_CC = 10;

/**
 * The copied addresses together, as the card lists them: with the files, they come before the
 * text, and the card holds 600 characters.
 */
export const MAX_EMAIL_CC_CHARS = 300;

/** As many files as one email carries. */
export const MAX_EMAIL_FILES = 5;

/**
 * The files of one email together, before encoding. Resend takes 40 MB once encoded, and base64
 * grows a file by a third: 20 MB leaves room for the text, and is what most mailboxes accept.
 */
export const MAX_EMAIL_FILES_BYTES = 20 * 1024 * 1024;

/** A file the agent names for an email: one of its conversation's, or one on the machine. */
export type EmailFileRequest = {
  mediaId?: string | undefined;
  path?: string | undefined;
  name?: string | undefined;
};

export type EmailFile = { name: string; mimeType: MediaMime; bytes: number; data: string };

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** A name a mail client shows as one file: no folders, no control characters. */
const fileName = (value: string) =>
  [...value]
    .map((char) => (char < ' ' || char === '\u007f' || char === '/' || char === '\\' ? '_' : char))
    .join('')
    .trim()
    .slice(0, 200);

/**
 * One file, read as the send tools read it: a media id of this conversation only, and a path the
 * file tools could read, held to the same size as any file sent. `read: false` stops at its size,
 * for the owner's card, so nothing large is read only to be shown.
 */
async function emailFile(
  db: Queryable,
  profileId: string,
  sessionId: string,
  file: EmailFileRequest,
  read: boolean,
): Promise<Omit<EmailFile, 'data'> & { data?: string }> {
  if (Boolean(file.mediaId) === Boolean(file.path))
    throw new GatewayError(400, 'Give each attachment a mediaId or a path, not both');

  if (file.mediaId) {
    const asset = await findMedia(db, profileId, file.mediaId);
    if (asset.sessionId !== sessionId)
      throw new GatewayError(404, 'That media is not part of this conversation');
    return {
      name: fileName(file.name ?? fileNameOf(asset.mimeType, asset.name)),
      mimeType: asset.mimeType as MediaMime,
      bytes: asset.bytes,
      ...(read ? { data: asset.data } : {}),
    };
  }

  const path = file.path as string;
  if (!isAbsolute(path)) throw new GatewayError(400, 'Use an absolute path');
  const handle = await openToRead(path);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new GatewayError(400, `${path} is not a file`);
    if (info.size > MAX_MEDIA_BYTES)
      throw new GatewayError(413, `Files over ${megabytes(MAX_MEDIA_BYTES)} cannot be sent`);
    const name = fileName(file.name ?? basename(path));
    const data = read ? await handle.readFile() : undefined;
    if (data && !data.length) throw new GatewayError(400, `${path} is empty`);
    return {
      name,
      mimeType: mediaMimeOf(undefined, name),
      bytes: data?.length ?? info.size,
      ...(data ? { data: data.toString('base64') } : {}),
    };
  } finally {
    await handle.close();
  }
}

/** The addresses an email copies, bare and once each, without its `to` or the agent's own. */
export function copiedAddresses(cc: readonly string[], to: string, own: string): string[] {
  if (cc.length > MAX_EMAIL_CC)
    throw new GatewayError(400, `An email copies at most ${MAX_EMAIL_CC} addresses`);
  const copied = new Set<string>();
  for (const given of cc) {
    const address = bareAddress(given);
    if (!address || address.length > 100)
      throw new GatewayError(400, `${given.slice(0, 100)} is not an email address`);
    if (address === own) throw new GatewayError(409, "That is this agent's own address");
    if (address !== to) copied.add(address);
  }
  return [...copied];
}

/**
 * Stores an email's files in the conversation that keeps it, as its media, under ids the email's
 * own fixes, so a repeated call stores them once. Returns their ids, in order.
 */
export async function keepEmailFiles(
  tx: Queryable,
  email: { profileId: string; sessionId: string; runId: string; id: string },
  files: readonly EmailFile[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, file] of files.entries()) {
    const id = stableUuid(`email-file:${email.id}:${index}`);
    await tx
      .insert(mediaAssets)
      .values({
        id,
        profileId: email.profileId,
        sessionId: email.sessionId,
        runId: email.runId,
        sourceKey: `email-file:${id}`,
        ...file,
      })
      .onConflictDoNothing();
    ids.push(id);
  }
  return ids;
}

/** The files of an email, read and held to its limits, before anything is queued. */
export async function emailFiles(
  db: Queryable,
  profileId: string,
  sessionId: string,
  files: readonly EmailFileRequest[],
): Promise<EmailFile[]> {
  if (files.length > MAX_EMAIL_FILES)
    throw new GatewayError(400, `An email carries at most ${MAX_EMAIL_FILES} files`);
  const read: EmailFile[] = [];
  let total = 0;
  for (const file of files) {
    const one = (await emailFile(db, profileId, sessionId, file, true)) as EmailFile;
    total += one.bytes;
    if (total > MAX_EMAIL_FILES_BYTES)
      throw new GatewayError(
        413,
        `The files of one email may weigh ${megabytes(MAX_EMAIL_FILES_BYTES)} together; send the rest in another email or share a link`,
      );
    read.push(one);
  }
  return read;
}

/** The files as the owner's card names them: name and size, or why one cannot be sent. */
export async function emailFileLines(
  db: Queryable,
  profileId: string,
  sessionId: string,
  files: readonly EmailFileRequest[],
): Promise<string[]> {
  const lines: string[] = [];
  for (const file of files.slice(0, MAX_EMAIL_FILES)) {
    const shown = await emailFile(db, profileId, sessionId, file, false).then(
      (found) => `${found.name.slice(0, 40)} (${size(found.bytes)})`,
      () => `${(file.path ?? file.mediaId ?? '').slice(-40)} (cannot be read)`,
    );
    lines.push(shown);
  }
  return lines;
}

/** A size as a person reads it: bytes, kilobytes or megabytes, to one decimal past a kilobyte. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

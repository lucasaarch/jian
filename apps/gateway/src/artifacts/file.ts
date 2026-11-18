import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import {
  fileNameOf,
  MAX_MEDIA_BYTES,
  mediaMimeOf,
  type SessionArtifactFile,
  sessionArtifactFileSchema,
} from '@jian/contracts';
import { openToRead } from '../agent/workspace.js';
import { GatewayError } from '../core/errors.js';
import { findMedia } from '../media/repository.js';
import type { Queryable } from '../storage/database.js';
import { mediaAssets } from '../storage/schema.js';

/**
 * A file as an Artifact. Its bytes are kept where every file of a conversation is, with its
 * media, and a version's `content` only names them (`sessionArtifactFileSchema`, in JSON). So a
 * file is stored once, goes when its conversation goes, and no version is ever changed: another
 * file is another row of media and another version.
 */

/** The file a version names. */
export const fileOf = (content: string): SessionArtifactFile =>
  sessionArtifactFileSchema.parse(JSON.parse(content));

/** Group files nobody sent to the agent, of which only the newest are kept (media/service.ts). */
const PASSING = 'heard:';

/**
 * What a version keeps for the file the agent gave: an attachment of this conversation, or a
 * file it reads from disk, held to the same line as the file tools. One read from disk becomes
 * media of the conversation. An attachment is named where it already is, with no copy, unless
 * it is one of those the gateway forgets by itself: a copy of that one stays with the Artifact.
 */
export async function keptFile(
  tx: Queryable,
  profileId: string,
  sessionId: string,
  given: { path?: string | undefined; mediaId?: string | undefined },
): Promise<string> {
  if ((given.path === undefined) === (given.mediaId === undefined)) {
    throw new GatewayError(
      400,
      'A file Artifact is given as `path`, a file within your reach, or as `mediaId`, an attachment of this conversation: one of the two.',
    );
  }
  let stored: { id: string; mimeType: string; name: string | null; bytes: number };

  if (given.mediaId !== undefined) {
    const asset = await findMedia(tx, profileId, given.mediaId);
    if (asset.sessionId !== sessionId) {
      throw new GatewayError(409, 'That media is not part of this conversation.');
    }
    stored = asset;
    if (asset.sourceKey.startsWith(PASSING)) {
      const id = randomUUID();
      await tx.insert(mediaAssets).values({
        id,
        profileId,
        sessionId,
        sourceKey: `artifact:${id}`,
        mimeType: asset.mimeType,
        name: asset.name,
        data: asset.data,
        bytes: asset.bytes,
      });
      stored = { ...asset, id };
    }
  } else {
    const path = given.path as string;
    if (!isAbsolute(path)) throw new GatewayError(400, 'Use an absolute path.');
    const handle = await openToRead(path);
    let data: Buffer;

    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new GatewayError(400, 'That path is not a file.');
      if (info.size > MAX_MEDIA_BYTES) {
        throw new GatewayError(413, 'A file over 16 MB cannot be an Artifact.');
      }
      data = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (!data.length) throw new GatewayError(400, 'The file is empty.');
    // The size is asked again of what was read: a file can grow between the two.
    if (data.length > MAX_MEDIA_BYTES) {
      throw new GatewayError(413, 'A file over 16 MB cannot be an Artifact.');
    }
    const name = basename(path).slice(0, 200);
    stored = {
      id: randomUUID(),
      mimeType: mediaMimeOf(undefined, name),
      name,
      bytes: data.length,
    };
    await tx.insert(mediaAssets).values({
      ...stored,
      profileId,
      sessionId,
      sourceKey: `artifact:${stored.id}`,
      data: data.toString('base64'),
    });
  }

  return JSON.stringify({
    mediaId: stored.id,
    name: fileNameOf(stored.mimeType, stored.name),
    mimeType: stored.mimeType,
    bytes: stored.bytes,
  } satisfies SessionArtifactFile);
}

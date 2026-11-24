import { create } from 'zustand';
import type { MediaUpload } from '../api';
import { base64 } from '../attachments';
import type { Attachment } from './drafts';

/**
 * A message the owner sent that the conversation does not hold yet: drawn at once, as a
 * messenger does, while the gateway is asked. `sent` waits for the history to bring the stored
 * message, the turn's run naming it; `failed` stays, with why, until it is sent again or let go.
 */
export type Outgoing = {
  key: string;
  sessionId: string;
  text: string;
  mediaIds: string[];
  /**
   * Files the message carries that may not be uploaded yet, drawn from their local previews
   * until the stored message brings them back. Their ids join `mediaIds` only on the wire.
   */
  files?: Attachment[];
  replyTo?: { id: string; content: string };
  at: string;
  state: 'sending' | 'failed' | 'sent';
  error?: string;
  runId?: string;
  /**
   * A command, not something said: no bubble while it is sent, only the agent starting, since
   * the conversation never shows it. One that fails is drawn, to be sent again.
   */
  quiet?: boolean;
};

/** Compacts the conversation's context now; the gateway keeps it out of the chat. */
export const COMPACT_COMMAND = '/compact';

export const useOutbox = create<{ items: Outgoing[] }>(() => ({ items: [] }));

/** Each message's way of being sent, kept out of the state: one key, every attempt. */
const senders = new Map<string, () => Promise<void>>();

const update = (key: string, change: (item: Outgoing) => Outgoing) =>
  useOutbox.setState((state) => ({
    items: state.items.map((item) => (item.key === key ? change(item) : item)),
  }));

/**
 * Each file's upload, by the attachment's key, so that the composer's eager upload, the first
 * attempt and every retry share one: a file that went up is never sent again, and one that
 * failed is tried again from the file the browser still holds.
 */
const uploads = new Map<string, Promise<string>>();

export function uploadOnce(
  file: Attachment,
  upload: (file: MediaUpload) => Promise<{ id: string }>,
): Promise<string> {
  const known = uploads.get(file.key);
  if (known) return known;
  const { file: blob, mimeType } = file;
  const started = (async () => {
    if (file.id) return file.id;
    if (!blob || !mimeType) throw new Error(`Could not upload ${file.name}.`);
    return (
      await upload({
        mimeType,
        data: await base64(blob),
        name: file.name,
        ...(file.voice ? { voice: true } : {}),
      })
    ).id;
  })();
  uploads.set(file.key, started);
  // A failure is not remembered: the next attempt uploads again.
  started.catch(() => uploads.delete(file.key));
  return started;
}

/** Lets files go for good: their upload record, and the memory their previews hold. */
export function releaseFiles(files: Attachment[] = []) {
  for (const file of files) {
    uploads.delete(file.key);
    if (file.preview) URL.revokeObjectURL(file.preview);
  }
}

const remove = (keys: Set<string>) => {
  for (const key of keys) senders.delete(key);
  for (const item of useOutbox.getState().items) if (keys.has(item.key)) releaseFiles(item.files);
  useOutbox.setState((state) => ({ items: state.items.filter((item) => !keys.has(item.key)) }));
};

/**
 * Shows a message as sent and sends it. `deliver` posts it under `key`, which the gateway keeps
 * per message, so an attempt made again after one that did land is the same message, not a
 * second. `delivered` runs once it has, to read the conversation again.
 */
export function sendNow(message: {
  sessionId: string;
  text: string;
  mediaIds: string[];
  /** Files to upload with `upload` behind the bubble, or already up; sent once all are. */
  attached?: { files: Attachment[]; upload: (file: MediaUpload) => Promise<{ id: string }> };
  replyTo?: { id: string; content: string };
  deliver: (key: string, mediaIds: string[]) => Promise<{ id: string }>;
  delivered: () => void;
}): void {
  const key = crypto.randomUUID();
  const attempt = async () => {
    update(key, ({ error: _was, ...item }) => ({ ...item, state: 'sending' }));
    try {
      const { files = [], upload } = message.attached ?? {};
      const uploaded = await Promise.all(
        files.map((file) =>
          uploadOnce(file, upload as NonNullable<typeof upload>).catch((failure) => {
            const why = failure instanceof Error ? ` ${failure.message}` : '';
            throw new Error(`Could not upload ${file.name}.${why}`);
          }),
        ),
      );
      const run = await message.deliver(key, [...message.mediaIds, ...uploaded]);
      update(key, (item) => ({ ...item, state: 'sent', runId: run.id }));
      message.delivered();
    } catch (failure) {
      const error = failure instanceof Error ? failure.message : 'The message could not be sent.';
      update(key, (item) => ({ ...item, state: 'failed', error }));
    }
  };
  senders.set(key, attempt);
  useOutbox.setState((state) => ({
    items: [
      ...state.items,
      {
        key,
        sessionId: message.sessionId,
        text: message.text,
        mediaIds: message.mediaIds,
        ...(message.attached?.files.length ? { files: message.attached.files } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(!message.mediaIds.length &&
        !message.attached?.files.length &&
        message.text.trim() === COMPACT_COMMAND
          ? { quiet: true }
          : {}),
        at: new Date().toISOString(),
        state: 'sending',
      },
    ],
  }));
  void attempt();
}

/** Sends a failed message again, under the key it had. */
export const resend = (key: string) => void senders.get(key)?.();

/** Lets a failed message go: it never reached the conversation. */
export const discard = (key: string) => remove(new Set([key]));

/**
 * Whether the conversation now holds a sent message: the stored one carries the run it started
 * or joined, and the words, which tell apart two sent to one turn while it ran.
 */
export const landed = (
  item: Outgoing,
  messages: { role: string; runId?: string | undefined; content: string }[],
) =>
  item.state === 'sent' &&
  messages.some(
    (message) =>
      message.role === 'user' &&
      message.runId === item.runId &&
      message.content.includes(item.text),
  );

/** Forgets the sent messages the conversation has brought back, once it has. */
export const forgetLanded = (keys: string[]) => {
  if (keys.length) remove(new Set(keys));
};

import { X_HANDWRITTEN_SCOPES } from './catalog/index.js';
import type { XActor, XClient } from './client.js';
import { XFailure } from './failures.js';

/** What one append carries, in bytes; X recommends at most 5 MB and refuses over 8 MB. */
const SEGMENT_BYTES = 4 * 1024 * 1024;
/** How long X may process a video before the post goes on without waiting, in milliseconds. */
const PROCESSING_LIMIT_MS = 120_000;
const scopes = X_HANDWRITTEN_SCOPES.x_upload_media;

export type XMediaUse = 'post' | 'dm';

const CATEGORY_PREFIX: Record<XMediaUse, string> = { post: 'tweet', dm: 'dm' };

function category(mimeType: string, use: XMediaUse): string {
  const prefix = CATEGORY_PREFIX[use];

  if (mimeType === 'image/gif') return `${prefix}_gif`;
  if (mimeType.startsWith('image/')) return `${prefix}_image`;
  if (mimeType.startsWith('video/')) return `${prefix}_video`;

  throw new XFailure(400, `X takes images and videos in a post, not ${mimeType}.`);
}

type Processing = { state?: string; check_after_secs?: number; error?: { message?: string } };
type UploadAnswer = { data?: { id?: string; processing_info?: Processing } };

/**
 * X's v2 upload: initialize, append in segments, finalize, and wait while a video is processed.
 * The one path serves every size. A file too small to need it still takes it, because a one-shot
 * upload would mean a second way to fail for no saving a caller could see.
 */
export async function uploadMedia(
  client: Pick<XClient, 'call'>,
  account: XActor,
  file: { bytes: Buffer; mimeType: string },
  use: XMediaUse,
  signal?: AbortSignal,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
  const request = { scopes, acts: true, signal };
  const started = (await client.call(account, {
    ...request,
    method: 'POST',
    path: '/2/media/upload/initialize',
    body: {
      media_type: file.mimeType,
      total_bytes: file.bytes.length,
      media_category: category(file.mimeType, use),
    },
  })) as UploadAnswer;
  const id = started.data?.id;

  if (!id) throw new XFailure(502, 'X did not start the upload.');

  const path = `/2/media/upload/${encodeURIComponent(id)}`;

  for (let offset = 0, index = 0; offset < file.bytes.length; index += 1) {
    const form = new FormData();

    form.set('segment_index', String(index));
    form.set(
      'media',
      new Blob([new Uint8Array(file.bytes.subarray(offset, offset + SEGMENT_BYTES))]),
    );
    await client.call(account, { ...request, method: 'POST', path: `${path}/append`, form });
    offset += SEGMENT_BYTES;
  }

  let answer = (await client.call(account, {
    ...request,
    method: 'POST',
    path: `${path}/finalize`,
  })) as UploadAnswer;
  let waited = 0;

  while (answer.data?.processing_info && answer.data.processing_info.state !== 'succeeded') {
    const info = answer.data.processing_info;

    if (info.state === 'failed') {
      throw new XFailure(400, `X could not process this file: ${info.error?.message ?? 'failed'}.`);
    }
    if (waited >= PROCESSING_LIMIT_MS) {
      throw new XFailure(504, `X is still processing media ${id}. It can be attached once done.`);
    }

    const pause = Math.max(1, info.check_after_secs ?? 2) * 1000;

    await wait(pause);
    waited += pause;
    answer = (await client.call(account, {
      ...request,
      acts: false,
      method: 'GET',
      path: '/2/media/upload',
      query: { command: 'STATUS', media_id: id },
    })) as UploadAnswer;
  }

  return id;
}

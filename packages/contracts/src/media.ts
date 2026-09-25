import { z } from 'zod';

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export const mediaMimeSchema = z.enum([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/flac',
  // Documents: a PDF goes to a model that reads PDFs, the rest are read as text.
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/xml',
  // Office and OpenDocument files: the gateway extracts their text.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  // Kept and passed on as they are; the agent opens them on the machine when it has one.
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/rtf',
  'application/zip',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/octet-stream',
]);
export type MediaMime = z.infer<typeof mediaMimeSchema>;

const BY_EXTENSION: Record<string, MediaMime> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  rtf: 'application/rtf',
  zip: 'application/zip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

const ALIASES: Record<string, MediaMime> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'text/x-markdown': 'text/markdown',
  'text/xml': 'application/xml',
  'application/x-zip-compressed': 'application/zip',
};

/** The name a file goes out under: its own, or one whose extension tells its type. */
export function fileNameOf(mimeType: string, name?: string | null) {
  if (name) return name;
  const extension = Object.entries(BY_EXTENSION).find(([, type]) => type === mimeType)?.[0];
  return `file.${extension ?? 'bin'}`;
}

/**
 * The type a received file is stored under. Channels report whatever the sender's device said,
 * sometimes with parameters or an alias, sometimes nothing; the extension decides then, and a
 * file nobody can name is still kept, as bytes, instead of being refused.
 */
export function mediaMimeOf(reported?: string | null, name?: string | null): MediaMime {
  const type = reported?.split(';')[0]?.trim().toLowerCase() ?? '';
  const known = mediaMimeSchema.safeParse(ALIASES[type] ?? type);
  if (known.success && known.data !== 'application/octet-stream') return known.data;
  const extension = name?.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1];
  return (extension && BY_EXTENSION[extension]) || known.data || 'application/octet-stream';
}

/** How many attachments one message may carry. */
export const MAX_MESSAGE_MEDIA = 10;
export const inlineMediaSchema = z.strictObject({
  mimeType: mediaMimeSchema,
  data: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_MEDIA_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  voice: z.boolean().optional(),
  // A sticker, not a photo: it goes out as one, and the agent keeps it to send again.
  sticker: z.boolean().optional(),
  // The file name it had, shown on a document and used when it is downloaded again.
  name: z.string().trim().min(1).max(200).optional(),
});
export const mediaRecordSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  mimeType: mediaMimeSchema,
  name: z.string().optional(),
  sticker: z.boolean().optional(),
  bytes: z.number().int().positive().max(MAX_MEDIA_BYTES),
  createdAt: z.iso.datetime(),
});
export const mediaContentSchema = mediaRecordSchema.extend({ data: z.string() });
export type InlineMedia = z.infer<typeof inlineMediaSchema>;
export type MediaRecord = z.infer<typeof mediaRecordSchema>;

/** A sticker the agent has seen and may send: what it shows, and how often it was sent. */
export const stickerSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  // Written by the image-analysis model when the sticker is first kept; absent until then.
  description: z.string().optional(),
  uses: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().optional(),
});
export const stickerImageSchema = stickerSchema.extend({
  mimeType: z.literal('image/webp'),
  data: z.string(),
});
export type Sticker = z.infer<typeof stickerSchema>;

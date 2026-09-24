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
  'application/json',
]);

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
  // The file name it had, shown on a document and used when it is downloaded again.
  name: z.string().trim().min(1).max(200).optional(),
});
export const mediaRecordSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  mimeType: mediaMimeSchema,
  name: z.string().optional(),
  bytes: z.number().int().positive().max(MAX_MEDIA_BYTES),
  createdAt: z.iso.datetime(),
});
export const mediaContentSchema = mediaRecordSchema.extend({ data: z.string() });
export type InlineMedia = z.infer<typeof inlineMediaSchema>;
export type MediaRecord = z.infer<typeof mediaRecordSchema>;

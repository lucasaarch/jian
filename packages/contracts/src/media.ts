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
]);
export const inlineMediaSchema = z.strictObject({
  mimeType: mediaMimeSchema,
  data: z
    .string()
    .min(4)
    .max(Math.ceil(MAX_MEDIA_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  voice: z.boolean().optional(),
});
export const mediaRecordSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  mimeType: mediaMimeSchema,
  bytes: z.number().int().positive().max(MAX_MEDIA_BYTES),
  createdAt: z.iso.datetime(),
});
export const mediaContentSchema = mediaRecordSchema.extend({ data: z.string() });
export type InlineMedia = z.infer<typeof inlineMediaSchema>;
export type MediaRecord = z.infer<typeof mediaRecordSchema>;

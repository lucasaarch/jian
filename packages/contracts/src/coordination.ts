import { z } from 'zod';

export const pageQuerySchema = z.strictObject({
  before: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().trim().min(1).max(200).optional(),
});

export const artifactSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  runId: z.uuid(),
  toolName: z.string(),
  content: z.string(),
  bytes: z.number().int(),
  createdAt: z.iso.datetime(),
});

export const artifactPageSchema = artifactSchema.omit({ content: true }).extend({
  content: z.string(),
  nextOffset: z.number().int().nullable(),
});

export const artifactQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(16000).default(4000),
});

export const leaseInputSchema = z.strictObject({
  sessionId: z.uuid(),
  resource: z.string().regex(/^[a-zA-Z0-9_./:-]{1,200}$/),
  ttlSeconds: z.number().int().min(5).max(300).default(60),
});

export const leaseSchema = leaseInputSchema.omit({ ttlSeconds: true }).extend({
  id: z.string(),
  profileId: z.uuid(),
  fence: z.number().int().positive(),
  expiresAt: z.number(),
});

export const mailInputSchema = z.strictObject({
  fromSessionId: z.uuid(),
  toSessionId: z.uuid(),
  text: z.string().trim().min(1).max(4000),
  requestKey: z.string().min(1).max(120),
});

export const mailSchema = mailInputSchema.extend({
  id: z.string(),
  profileId: z.uuid(),
  createdAt: z.iso.datetime(),
});

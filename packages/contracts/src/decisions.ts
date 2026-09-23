import { z } from 'zod';
import { secretSchema } from './security.js';

/**
 * The service that answers the gateway's own yes-or-no questions — whether a group message
 * calls an agent, whether a command goes further than it was asked to. It writes no text and
 * runs no conversation, so it chooses no model: without it, every question falls back to the
 * fixed rule the gateway used before.
 */
export const decisionProviderSchema = z.enum(['jev']);

export const decisionsInputSchema = z.strictObject({
  provider: decisionProviderSchema,
  apiKey: secretSchema,
});

export const decisionsStatusSchema = z.strictObject({
  provider: decisionProviderSchema,
  configured: z.boolean(),
  updatedAt: z.iso.datetime().optional(),
});

export type DecisionsStatus = z.infer<typeof decisionsStatusSchema>;

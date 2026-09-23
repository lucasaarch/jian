import { z } from 'zod';
import { secretSchema } from './security.js';

/**
 * The search service the whole installation shares. One service answers every agent, whatever
 * model it runs on, so a search works the same for all of them; the key is typed once.
 */
export const webSearchProviderSchema = z.enum(['tavily']);

export const webSearchInputSchema = z.strictObject({
  provider: webSearchProviderSchema,
  apiKey: secretSchema,
});

export const webSearchStatusSchema = z.strictObject({
  provider: webSearchProviderSchema,
  configured: z.boolean(),
  updatedAt: z.iso.datetime().optional(),
});

export type WebSearchStatus = z.infer<typeof webSearchStatusSchema>;

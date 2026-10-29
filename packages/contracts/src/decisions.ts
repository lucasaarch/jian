import { z } from 'zod';
import { secretSchema } from './security.js';

/**
 * The service that answers the gateway's own questions — whether a group message calls an
 * agent, what a chat reply to a pending approval means. It writes no text and runs no
 * conversation, so it chooses no model: without it, every question falls back to the fixed
 * rule the gateway used before.
 */
export const decisionProviderSchema = z.enum(['jev']);

/**
 * What the gateway asks the service about, each switched on or off by the owner. A use that is
 * off decides by its fixed rule, as if there were no key.
 * - outside: pages, searches and service results that try to give the agent orders;
 * - turn: before each turn, which memories and skill fit it and whether it is light;
 * - memories: a new memory about a subject already kept;
 * - learning: whether finished work holds something worth keeping;
 * - groups: whether a group message is speaking to an agent;
 * - delegation: how much model a subagent's work needs, when the agent leaves it open;
 * - replies: what a chat reply to a pending approval or question means.
 *
 * Whether an action may run is not among them: that is the conversation's protection mode,
 * the owner's own rule, and no judgment stands in for it.
 */
export const decisionUseSchema = z.enum([
  'outside',
  'turn',
  'memories',
  'learning',
  'groups',
  'delegation',
  'replies',
]);

export const decisionsInputSchema = z.strictObject({
  provider: decisionProviderSchema,
  apiKey: secretSchema,
});

export const decisionUsesSchema = z.strictObject({
  outside: z.boolean(),
  turn: z.boolean(),
  memories: z.boolean(),
  learning: z.boolean(),
  groups: z.boolean(),
  delegation: z.boolean(),
  replies: z.boolean(),
});

/** Which decisions the owner wants to ask Jev about. */
export const decisionsSettingsPatchSchema = z.strictObject({
  uses: decisionUsesSchema.partial().optional(),
});

/** The spending of one use on one UTC day. An answer served from the cache costs nothing. */
export const decisionUsageSchema = z.strictObject({
  day: z.iso.date(),
  use: decisionUseSchema,
  requests: z.number().int().min(0),
  cached: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});

export const decisionsStatusSchema = z.strictObject({
  provider: decisionProviderSchema,
  configured: z.boolean(),
  updatedAt: z.iso.datetime().optional(),
  uses: decisionUsesSchema,
  /** The last seven UTC days, most recent first; days and uses with nothing spent are absent. */
  usage: z.array(decisionUsageSchema),
});

export type DecisionUse = z.infer<typeof decisionUseSchema>;
export type DecisionUses = z.infer<typeof decisionUsesSchema>;
export type DecisionUsage = z.infer<typeof decisionUsageSchema>;
export type DecisionsSettingsPatch = z.infer<typeof decisionsSettingsPatchSchema>;
export type DecisionsStatus = z.infer<typeof decisionsStatusSchema>;

import { z } from 'zod';

/** How many event subscriptions one profile may keep. */
export const SUBSCRIPTION_LIMIT = 50;

export const subscriptionSourceSchema = z.enum(['github']);

/**
 * GitHub events this MVP can wake on. Broader taxonomy comes later; keep the filter narrow so
 * a misconfigured webhook cannot flood the agent.
 */
export const githubSubscriptionEventSchema = z.enum([
  'check_suite.completed',
  'pull_request.closed',
]);

export const githubSubscriptionFilterSchema = z.strictObject({
  owner: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/),
  repo: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/),
  events: z.array(githubSubscriptionEventSchema).min(1).max(8),
});

const subscriptionFields = {
  name: z.string().trim().min(1).max(80),
  /** What the agent should do when the event fires, as if the owner wrote it then. */
  instruction: z.string().trim().min(1).max(4_000),
  sessionId: z.uuid(),
  source: subscriptionSourceSchema,
  filter: githubSubscriptionFilterSchema,
  enabled: z.boolean().default(true),
};

export const subscriptionInputSchema = z.strictObject(subscriptionFields);

export const subscriptionPatchSchema = z.strictObject({
  name: subscriptionFields.name.optional(),
  instruction: subscriptionFields.instruction.optional(),
  sessionId: subscriptionFields.sessionId.optional(),
  filter: subscriptionFields.filter.optional(),
  enabled: z.boolean().optional(),
});

export const subscriptionRecordSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  name: z.string(),
  instruction: z.string(),
  sessionId: z.uuid(),
  source: subscriptionSourceSchema,
  filter: githubSubscriptionFilterSchema,
  enabled: z.boolean(),
  createdBy: z.enum(['owner', 'agent']),
  /** Present once on create: webhook secret for GitHub. Never stored or returned again. */
  webhookSecret: z.string().min(1).max(200).optional(),
  lastWakeAt: z.iso.datetime().optional(),
  lastRunId: z.uuid().optional(),
  lastError: z.string().max(2000).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const subscriptionDeliverySchema = z.strictObject({
  id: z.uuid(),
  subscriptionId: z.uuid(),
  profileId: z.uuid(),
  deliveryKey: z.string(),
  event: z.string(),
  runId: z.uuid().optional(),
  error: z.string().optional(),
  createdAt: z.iso.datetime(),
});

export type Subscription = z.infer<typeof subscriptionRecordSchema>;
export type SubscriptionInput = z.infer<typeof subscriptionInputSchema>;
export type SubscriptionPatch = z.infer<typeof subscriptionPatchSchema>;
export type SubscriptionDelivery = z.infer<typeof subscriptionDeliverySchema>;

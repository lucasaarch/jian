import { z } from 'zod';

/** How many event subscriptions one profile may keep. */
export const SUBSCRIPTION_LIMIT = 50;

/** Default gap between GitHub polls, in seconds. */
export const SUBSCRIPTION_DEFAULT_POLL_SECONDS = 30;
/** Shortest gap the gateway will poll a subscription, in seconds. */
export const SUBSCRIPTION_MIN_POLL_SECONDS = 15;
/** Longest gap the gateway will poll a subscription, in seconds. */
export const SUBSCRIPTION_MAX_POLL_SECONDS = 3_600;

/**
 * How long a listener stays on when the agent omits a duration. One hour covers a typical
 * CI wait without leaving an infinite watch after the owner walks away.
 */
export const SUBSCRIPTION_DEFAULT_TTL_SECONDS = 3_600;
/** Shortest TTL the agent may set, in seconds (five minutes). */
export const SUBSCRIPTION_MIN_TTL_SECONDS = 300;
/** Longest TTL the agent may set, in seconds (seven days). */
export const SUBSCRIPTION_MAX_TTL_SECONDS = 7 * 24 * 3_600;

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
  /**
   * Pull request to watch. Polling needs this to check CI or merge state; without it the
   * subscription still accepts an optional webhook but will not poll usefully.
   */
  pullNumber: z.number().int().positive().max(1_000_000).optional(),
  /** When set, only this check run name counts as the CI event (e.g. "Check"). */
  checkName: z.string().trim().min(1).max(200).optional(),
  /** How often the gateway polls GitHub for a state change. */
  pollIntervalSeconds: z
    .number()
    .int()
    .min(SUBSCRIPTION_MIN_POLL_SECONDS)
    .max(SUBSCRIPTION_MAX_POLL_SECONDS)
    .default(SUBSCRIPTION_DEFAULT_POLL_SECONDS),
});

const subscriptionFields = {
  name: z.string().trim().min(1).max(80),
  /** What the agent should do when the event fires, as if the owner wrote it then. */
  instruction: z.string().trim().min(1).max(4_000),
  sessionId: z.uuid(),
  source: subscriptionSourceSchema,
  filter: githubSubscriptionFilterSchema,
  enabled: z.boolean().default(true),
  /**
   * How long this listener stays active from create/update. Omit for the default (1 hour).
   * Common values: 1800 (30 minutes), 3600 (1 hour), 86400 (1 day).
   */
  durationSeconds: z
    .number()
    .int()
    .min(SUBSCRIPTION_MIN_TTL_SECONDS)
    .max(SUBSCRIPTION_MAX_TTL_SECONDS)
    .optional(),
};

export const subscriptionInputSchema = z.strictObject(subscriptionFields);

export const subscriptionPatchSchema = z.strictObject({
  name: subscriptionFields.name.optional(),
  instruction: subscriptionFields.instruction.optional(),
  sessionId: subscriptionFields.sessionId.optional(),
  filter: subscriptionFields.filter.optional(),
  enabled: z.boolean().optional(),
  durationSeconds: subscriptionFields.durationSeconds,
});

/** Last GitHub state the poller saw, used to detect transitions. */
export const subscriptionObservationSchema = z.strictObject({
  pullState: z.enum(['open', 'closed']).optional(),
  merged: z.boolean().optional(),
  headSha: z.string().optional(),
  checksCompleted: z.boolean().optional(),
  checkConclusion: z.string().optional(),
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
  /** Present once on create: optional webhook secret for GitHub. Never stored or returned again. */
  webhookSecret: z.string().min(1).max(200).optional(),
  /** When the gateway will next poll GitHub (absent while switched off or expired). */
  nextPollAt: z.iso.datetime().optional(),
  lastObservation: subscriptionObservationSchema.optional(),
  lastWakeAt: z.iso.datetime().optional(),
  lastRunId: z.uuid().optional(),
  lastError: z.string().max(2000).optional(),
  /** When this listener stops polling. Always set on create; extend via durationSeconds. */
  expiresAt: z.iso.datetime(),
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
export type SubscriptionObservation = z.infer<typeof subscriptionObservationSchema>;

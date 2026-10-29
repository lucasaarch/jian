import { z } from 'zod';
import { modelSelectionSchema } from './providers.js';
import { runProgressSchema } from './run-progress.js';

export const subagentRoleSchema = z.enum(['execute', 'review']);

/**
 * How much model a subagent's work needs. Each tier maps to a model the installation offers,
 * subscriptions first; see the gateway's `providers/tiers.ts`.
 * - light: small and well defined, a lookup, a rename, a short text;
 * - standard: a bounded change across a few files, with tests to run;
 * - deep: several files or systems, risky, or in need of a plan.
 */
export const subagentTierSchema = z.enum(['light', 'standard', 'deep']);
export type SubagentTier = z.infer<typeof subagentTierSchema>;

/** Who settled the tier: the agent that asked, Jev reading the brief, or the fallback. */
export const subagentTierBySchema = z.enum(['agent', 'jev', 'default']);

export const conversationSubagentInputSchema = z.strictObject({
  role: subagentRoleSchema,
  name: z.string().trim().min(1).max(80),
  identity: z.string().trim().min(1).max(4000),
  brief: z.string().trim().min(1).max(3000),
  mediaIds: z.array(z.uuid()).max(4).optional(),
  repositories: z.array(z.string().trim().min(1).max(4096)).max(4).optional(),
  /** Left out, or `auto`, Jev reads the brief and picks; without Jev it is `standard`. */
  tier: z.enum(['auto', 'light', 'standard', 'deep']).optional(),
});

export const subagentSchema = conversationSubagentInputSchema
  .pick({ role: true, name: true, identity: true })
  .extend({
    parentRunId: z.uuid(),
    spawnKey: z.string().min(1).max(120),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    repositories: z.array(z.string()).max(4).optional(),
    // Optional because subagents spawned before tiers existed are stored without them, and
    // every run row is parsed through this schema.
    tier: subagentTierSchema.optional(),
    tierBy: subagentTierBySchema.optional(),
  });
export type Subagent = z.infer<typeof subagentSchema>;

export const conversationSubagentSchema = z.strictObject({
  runId: z.uuid(),
  sessionId: z.uuid(),
  parentRunId: z.uuid(),
  role: subagentRoleSchema,
  name: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']),
  input: z.string(),
  output: z.string().optional(),
  error: z.string().optional(),
  tier: subagentTierSchema.optional(),
  tierBy: subagentTierBySchema.optional(),
  /** The model the run froze when it was submitted. */
  modelSelection: modelSelectionSchema.optional(),
  /** What it is doing now, while it runs. */
  progress: runProgressSchema.optional(),
  createdAt: z.iso.datetime(),
  /** Once the run has ended, when it did. */
  updatedAt: z.iso.datetime(),
});

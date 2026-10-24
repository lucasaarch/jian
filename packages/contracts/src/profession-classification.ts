import { z } from 'zod';
import { capabilitySchema, professionIdSchema } from './professions.js';

/** Read-only planning input, not consent to classify or a token accepted by a later write. */
export const professionPreviewInputSchema = z.strictObject({
  professionId: professionIdSchema,
  expectedVersion: z.number().int().positive(),
});

const count = z.number().int().nonnegative();

/** Counts are advisory observations. Any eventual transition must revalidate under its lock. */
export const professionPreviewSchema = z.strictObject({
  profileId: z.uuid(),
  profileVersion: z.number().int().positive(),
  professionId: professionIdSchema,
  policyVersion: z.number().int().positive(),
  assignable: z.literal(false),
  blockers: z.array(z.enum(['unavailable', 'already_classified', 'unsettled_work'])),
  configurationCapabilities: z.array(capabilitySchema),
  incompatibleMcpServers: z.array(z.string()),
  affected: z.strictObject({
    queuedRuns: count,
    runningRuns: count,
    waitingRuns: count,
    unsettledExecutions: count,
    pendingWorkerReports: count,
    historicalRunsWithoutAuthority: count,
    pendingRemoteTasks: count,
    enabledSchedules: count,
    enabledSubscriptions: count,
    liveChannels: count,
    openObjectives: count,
    customSkills: count,
    remoteMachines: count,
    learning: z.boolean(),
    peerCalls: z.boolean(),
  }),
});
export type ProfessionPreview = z.infer<typeof professionPreviewSchema>;

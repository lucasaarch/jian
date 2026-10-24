import { z } from 'zod';
import { capabilitySchema, professionIdSchema } from './professions.js';

/** Selection and expected profile version for a preview or one-time classification request. */
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
  assignable: z.boolean(),
  blockers: z.array(z.enum(['already_classified', 'unsettled_work'])),
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
    runningRemoteTasks: count,
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

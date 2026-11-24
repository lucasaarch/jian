import { z } from 'zod';

/** Commands an agent may have running in the background at once, per agent profile. */
export const AGENT_PROCESSES_RUNNING_MAX = 8;
/** Ended processes an agent profile keeps, with what they printed, before the oldest go. */
export const AGENT_PROCESSES_ENDED_KEPT = 20;

/**
 * A command the agent started in the background on the machine the gateway runs on. It lives in
 * the gateway's memory only: a restart ends it, and it is gone. Its live output is read from the
 * terminal stream, under this same id.
 */
export const agentProcessSchema = z.strictObject({
  id: z.uuid(),
  sessionId: z.uuid(),
  command: z.string().max(4000),
  /** The folder it started in. */
  cwd: z.string().max(4096),
  startedAt: z.iso.datetime(),
  /** `stopped` is one that ended because it was asked to; the others ended on their own. */
  status: z.enum(['running', 'exited', 'stopped']),
  /** Set once it has ended. */
  exitCode: z.number().int().optional(),
});

export const agentProcessParamsSchema = z.strictObject({
  profileId: z.uuid(),
  sessionId: z.uuid(),
  processId: z.uuid(),
});

export type AgentProcess = z.infer<typeof agentProcessSchema>;

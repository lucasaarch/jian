import { z } from 'zod';

/**
 * How many nested agent calls one conversation may pay for. The budget travels with the
 * chain: a run started by a call carries the depth already spent, so a colleague called by a
 * colleague inherits what was spent before it instead of starting over. Every hop is a real
 * model run on a real key, so the chain has to end somewhere and it ends here.
 */
export const AGENT_CALL_DEPTH_LIMIT = 3;

/** The channel of the session a pair of agents shares, kept on the called agent's side. */
export const AGENT_SESSION_CHANNEL = 'agent';

/**
 * Everything one agent may learn about another. Instructions, identity, memories, sessions
 * and history stay behind the profile wall; what an agent does is the owner's summary.
 */
export const agentCardSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  summary: z.string(),
});

export const agentCallSchema = z.strictObject({
  toProfileId: z.uuid(),
  text: z.string().trim().min(1).max(4_000),
  requestKey: z.string().min(1).max(120),
});

/**
 * Written on the called run: who asked, and what the chain has already spent. `chain` is the
 * ordered list of profiles this conversation has been through, so an agent that already
 * answered is never asked again inside the same chain.
 */
export const agentCallOriginSchema = z.strictObject({
  fromProfileId: z.uuid(),
  fromName: z.string().max(100),
  fromRunId: z.uuid(),
  /** The conversation that asked. A late answer is carried back into it as an ordinary turn. */
  fromSessionId: z.uuid().optional(),
  depth: z.number().int().min(1).max(AGENT_CALL_DEPTH_LIMIT),
  chain: z
    .array(z.uuid())
    .min(2)
    .max(AGENT_CALL_DEPTH_LIMIT + 1),
});

/**
 * What crosses back: text, and the name of who wrote it. `waiting` means the colleague is
 * still working — nobody blocks on a long errand, and their answer arrives in this
 * conversation later, as a turn of its own.
 */
export const agentAnswerSchema = z.strictObject({
  fromProfileId: z.uuid(),
  fromName: z.string(),
  status: z.enum(['answered', 'waiting']).default('answered'),
  text: z.string(),
});

export type AgentCard = z.infer<typeof agentCardSchema>;

export type AgentCall = z.infer<typeof agentCallSchema>;

export type AgentCallOrigin = z.infer<typeof agentCallOriginSchema>;

export type AgentAnswer = z.infer<typeof agentAnswerSchema>;

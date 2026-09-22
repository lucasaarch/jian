import type { AgentAnswer, AgentCard, Run } from '@jian/contracts';

/** How a run created by the gateway itself reaches the person it is for. */
export interface RunDelivery {
  deliverRun(profileId: string, sessionId: string, runId: string): Promise<void>;
}

/**
 * What a running profile may do with the other profiles of the installation: see who they are
 * and ask one of them something. Nothing here reads a foreign memory, credential or history.
 */
export interface PeerAgents {
  agents(profileId: string): Promise<AgentCard[]>;
  ask(run: Run, input: unknown, signal?: AbortSignal): Promise<AgentAnswer>;
  deliverLate(profileId: string, runId: string): Promise<void>;
  useDeliveries(deliveries: RunDelivery): void;
}

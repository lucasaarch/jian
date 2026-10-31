import type {
  AgentCallOrigin,
  Checkpoint,
  GroupTurn,
  Message,
  Run,
  RunApproval,
  RunProgress,
  RunQuestion,
  Subagent,
} from '@jian/contracts';
import type { Queryable } from '../storage/database.js';
import type { RunAction } from './action.js';

/** What decides a run beyond its text: where it continues from, who asked, what it may cost. */
export type SubmitOptions = {
  /** Set only by the authenticated owner-facing message route. */
  ownerMessage?: boolean;
  channelMessage?: Message['channelMessage'];
  continuationOf?: string;
  activity?: 'conversation' | 'channel';
  call?: AgentCallOrigin;
  group?: GroupTurn;
  /** Who wrote the message, when the conversation is a room with several people in it. */
  author?: { id: string; name?: string };
  subagent?: Subagent;
  transaction?: Queryable;
  /** Revalidate channel authority under the submission lock, after catalog/network work. */
  beforeSubmit?: (tx: Queryable) => Promise<void>;
  /**
   * The chat's decision on the approval this message answers, read by the channel from a
   * contact allowed to approve. Applied only to that approval, and only while it is pending.
   */
  approval?: { id: string; decision: 'approve' | 'reject'; note?: string };
  /** The answer a chat reply stands for, when it named a choice by number or in its own words. */
  answer?: string;
  /**
   * The gateway wrote this turn itself, not a person: the agent reads it, the conversation does
   * not show it. The auto-continue of an open objective is a `resume`.
   */
  purpose?: Message['purpose'];
};

export interface RunReader {
  run(profileId: string, runId: string, reader?: Queryable): Promise<Run>;
  activities(profileId: string): Promise<Run[]>;
}

export interface RunWriter extends RunReader {
  submit(
    profileId: string,
    sessionId: string,
    input: unknown,
    options?: SubmitOptions,
  ): Promise<Run>;
  cancel(profileId: string, runId: string, transaction?: Queryable): Promise<Run>;
  relayTo(profileId: string, runId: string, sessionId: string | null): Promise<void>;
}

/** The lease side of a run: every write here needs the owner that holds it. */
export interface RunExecution {
  claim(runId: string, profileId: string, owner: string): Promise<Run | null>;
  heartbeat(profileId: string, runId: string, owner: string): Promise<void>;
  checkpoint(profileId: string, runId: string, owner: string, data: unknown): Promise<void>;
  progress(runId: string, owner: string, progress: RunProgress | null): Promise<void>;
  steer(runId: string, owner: string): Promise<string | null>;
  say(profileId: string, runId: string, owner: string, text: string): Promise<void>;
  checkpoints(profileId: string, runId: string): Promise<Checkpoint[]>;
  recordUsage(
    profileId: string,
    runId: string,
    owner: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      estimated?: boolean;
      steps: number;
    },
  ): Promise<void>;
  finish(
    profileId: string,
    runId: string,
    owner: string,
    status: 'completed' | 'failed' | 'interrupted',
    content: string,
  ): Promise<Run>;
  wait(profileId: string, runId: string, owner: string, question: RunQuestion): Promise<Run>;
  waitForApproval(
    profileId: string,
    runId: string,
    owner: string,
    approval: RunApproval,
    action: RunAction,
  ): Promise<Run>;
}

export interface RunRecovery {
  /** Interrupts runs whose owner is gone; `alive` names owners still working in this process. */
  recover(alive?: ReadonlySet<string>): Promise<void>;
}

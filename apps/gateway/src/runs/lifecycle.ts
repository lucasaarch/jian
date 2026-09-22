import { randomUUID } from 'node:crypto';
import type { Checkpoint, Message, Run, RunProgress } from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { insertMessage } from '../sessions/repository.js';
import type { Store } from '../storage/database.js';
import type { RunReader } from './port.js';
import {
  appendCommentary,
  insertCheckpoint,
  listCheckpoints,
  listExpiredRuns,
  takeSteer,
  updateRun,
  writeProgress,
} from './repository.js';

/** The lease is the right to apply external effects, so a stale owner must never write. */
function assertOwned(run: Run, owner: string, clock: Clock): void {
  if (run.status !== 'running' || run.leaseOwner !== owner || (run.leaseUntil ?? 0) <= clock()) {
    throw new GatewayError(409, 'Run lease is no longer valid');
  }
}

export class RunLifecycle {
  constructor(
    private readonly store: Store,
    private readonly runs: RunReader,
    private readonly clock: Clock = Date.now,
  ) {}

  async claim(runId: string, profileId: string, owner: string) {
    return this.store.transaction(profileId, async (tx) => {
      const run = await this.runs.run(profileId, runId, tx);

      if (run.status !== 'queued') {
        return null;
      }

      const claimed: Run = {
        ...run,
        status: 'running',
        leaseOwner: owner,
        leaseUntil: this.clock() + 60_000,
        updatedAt: nowIso(this.clock),
      };

      await updateRun(tx, claimed);

      await recordEvent(
        tx,
        this.clock,
        profileId,
        'run.started',
        { sessionId: run.sessionId },
        run.id,
      );

      return claimed;
    });
  }

  async heartbeat(profileId: string, runId: string, owner: string) {
    await this.store.transaction(profileId, async (tx) => {
      const run = await this.runs.run(profileId, runId, tx);

      assertOwned(run, owner, this.clock);

      await updateRun(tx, {
        ...run,
        leaseUntil: this.clock() + 60_000,
        updatedAt: nowIso(this.clock),
      });
    });
  }

  /**
   * What the run is doing, for whoever is watching. It is not an event and not history: a
   * reader wants the latest state, and the answer itself is written once, when the run ends.
   */
  async progress(runId: string, owner: string, progress: RunProgress | null) {
    await writeProgress(this.store.db, runId, owner, progress);
  }

  /** What the person said while this run was already going, taken once and left empty. */
  async steer(runId: string, owner: string): Promise<string | null> {
    return takeSteer(this.store.db, runId, owner);
  }

  async checkpoint(profileId: string, runId: string, owner: string, data: unknown) {
    await this.store.transaction(profileId, async (tx) => {
      const run = await this.runs.run(profileId, runId, tx);

      assertOwned(run, owner, this.clock);

      const checkpoint: Checkpoint = {
        id: randomUUID(),
        profileId,
        runId,
        data,
        createdAt: nowIso(this.clock),
      };

      await insertCheckpoint(tx, checkpoint);

      await recordEvent(tx, this.clock, profileId, 'run.step', data, runId);
    });
  }

  /**
   * One thing the agent said before reaching for a tool. Kept on the run rather than written
   * to history: history is what the conversation holds, and a channel decides for itself
   * whether a person sees the working or only the answer.
   */
  async say(profileId: string, runId: string, owner: string, text: string): Promise<void> {
    await this.store.transaction(profileId, (tx) => appendCommentary(tx, runId, owner, text));
  }

  async checkpoints(profileId: string, runId: string) {
    await this.runs.run(profileId, runId);

    return listCheckpoints(this.store.db, profileId, runId, 100);
  }

  async recordUsage(
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
  ) {
    await this.store.transaction(profileId, async (tx) => {
      const run = await this.runs.run(profileId, runId, tx);

      assertOwned(run, owner, this.clock);

      const previous = run.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        estimated: false,
        steps: 0,
      };

      await updateRun(tx, {
        ...run,
        usage: {
          inputTokens: previous.inputTokens + usage.inputTokens,
          outputTokens: previous.outputTokens + usage.outputTokens,
          cachedInputTokens: previous.cachedInputTokens + (usage.cachedInputTokens ?? 0),
          // One counted step makes the whole run's number a count, not a report.
          estimated: previous.estimated || Boolean(usage.estimated),
          steps: previous.steps + usage.steps,
        },
      });
    });
  }

  async finish(
    profileId: string,
    runId: string,
    owner: string,
    status: 'completed' | 'failed' | 'interrupted',
    content: string,
  ) {
    return this.store.transaction(profileId, async (tx) => {
      const run = await this.runs.run(profileId, runId, tx);

      assertOwned(run, owner, this.clock);

      const final: Run = {
        ...run,
        status,
        updatedAt: nowIso(this.clock),
        leaseOwner: undefined,
        leaseUntil: undefined,
        // The answer is the message now; a half-written preview must not outlive the run.
        progress: undefined,
        ...(status === 'completed' ? { output: content } : { error: content }),
      };

      await updateRun(tx, final);

      if (status === 'completed') {
        const message: Message = {
          id: randomUUID(),
          profileId,
          sessionId: run.sessionId,
          runId,
          role: 'assistant',
          content,
          createdAt: nowIso(this.clock),
        };

        await insertMessage(tx, message);
      }

      await recordEvent(
        tx,
        this.clock,
        profileId,
        `run.${status}`,
        status === 'completed' ? { text: content } : { error: content },
        runId,
      );

      return final;
    });
  }

  // Expired ownership interrupts a run: replaying it could repeat completed external effects.
  async recover() {
    const expired = await listExpiredRuns(this.store.db, this.clock(), 1000);

    for (const run of expired) {
      await this.store.transaction(run.profileId, async (tx) => {
        const current = await this.runs.run(run.profileId, run.id, tx);

        if (current.status !== 'running' || (current.leaseUntil ?? 0) > this.clock()) {
          return;
        }

        const error = 'Worker lease expired. Inspect completed steps before starting another run.';

        await updateRun(tx, {
          ...current,
          status: 'interrupted',
          error,
          leaseOwner: undefined,
          leaseUntil: undefined,
          updatedAt: nowIso(this.clock),
        });

        await recordEvent(tx, this.clock, run.profileId, 'run.interrupted', { error }, run.id);
      });
    }
  }
}

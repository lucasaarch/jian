import { randomUUID } from 'node:crypto';
import type { Checkpoint, Message, Run, RunProgress, RunQuestion } from '@jian/contracts';
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { formatQuestionText } from '../agent/ask-user.js';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { insertMessage } from '../sessions/repository.js';
import type { Store } from '../storage/database.js';
import { runs as runRows } from '../storage/schema.js';
import { admitsRun, EXECUTION_LEASE_MS } from './drain.js';
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
import { consumeSessionEffects } from './session-effects.js';

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

      if (run.status !== 'queued' || !(await admitsRun(tx, run))) {
        return null;
      }
      // A drain can accumulate several queued messages in one session instead of steering.
      // Its profile lock serializes this check with every other claim in that session.
      const [inFlight] = await tx
        .select({ id: runRows.id })
        .from(runRows)
        .where(
          and(
            eq(runRows.sessionId, run.sessionId),
            or(eq(runRows.status, 'running'), isNotNull(runRows.executionOwner)),
          ),
        )
        .limit(1);
      if (inFlight) return null;

      const claimed: Run = {
        ...run,
        status: 'running',
        leaseOwner: owner,
        leaseUntil: this.clock() + 60_000,
        updatedAt: nowIso(this.clock),
      };

      // A marker survives terminal status and lease expiry until its execute tail closes.
      // Never overwrite one, including a marker on this queued run itself.
      const marked = await tx
        .update(runRows)
        .set({
          executionOwner: owner,
          // Initial deadline for diagnostics only, never authority to reclaim or release.
          executionUntil: sql`clock_timestamp() + ${EXECUTION_LEASE_MS} * interval '1 millisecond'`,
        })
        .where(and(eq(runRows.id, runId), isNull(runRows.executionOwner)))
        .returning({ id: runRows.id });
      if (!marked.length) return null;
      await updateRun(tx, claimed);
      await consumeSessionEffects(tx, profileId, runId, run.sessionId, this.clock);

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

  /** Called only after the execute tail and every owned resource have closed successfully. */
  async releaseExecution(runId: string, owner: string): Promise<void> {
    await this.store.db
      .update(runRows)
      .set({ executionOwner: null, executionUntil: null })
      .where(and(eq(runRows.id, runId), eq(runRows.executionOwner, owner)));
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
    await this.store.transaction(profileId, async (tx) => {
      await appendCommentary(tx, runId, owner, text);

      const run = await this.runs.run(profileId, runId, tx);

      // Also a turn of the conversation: what the chat received and what the panel shows are
      // the same sequence, and the next turn sees what this one already said.
      await insertMessage(tx, {
        id: randomUUID(),
        profileId,
        sessionId: run.sessionId,
        runId,
        role: 'assistant',
        content: text,
        createdAt: nowIso(this.clock),
      });
    });
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

  /**
   * Parks the run on an owner question. The lease is released so recover() cannot interrupt
   * parked work. The question is written once to commentary and history for the panel and
   * channels; delivery treats `waiting` as the moment to send it and close that delivery.
   */
  async wait(profileId: string, runId: string, owner: string, question: RunQuestion) {
    return this.store.transaction(profileId, async (tx) => {
      const run = await this.runs.run(profileId, runId, tx);

      assertOwned(run, owner, this.clock);

      const text = formatQuestionText(question);
      const waiting: Run = {
        ...run,
        status: 'waiting',
        question,
        output: text,
        updatedAt: nowIso(this.clock),
        leaseOwner: undefined,
        leaseUntil: undefined,
        progress: undefined,
      };

      await updateRun(tx, waiting);

      await insertMessage(tx, {
        id: randomUUID(),
        profileId,
        sessionId: run.sessionId,
        runId,
        role: 'assistant',
        content: text,
        createdAt: nowIso(this.clock),
      });

      await recordEvent(tx, this.clock, profileId, 'run.waiting', { question }, runId);

      return waiting;
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
        question: undefined,
        ...(status === 'completed' ? { output: content } : { error: content }),
      };

      await updateRun(tx, final);

      if (status === 'completed') {
        // Commentary already wrote this paragraph into history when a trailing blank line
        // released it early; inserting again would show the same line twice in the panel.
        const alreadySaid = run.commentary?.at(-1) === content;
        if (!alreadySaid) {
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

  // Expired run leases interrupt, never replay. The execution marker is deliberately retained:
  // a lease timeout does not prove external effects or the previous execute tail have ended.
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

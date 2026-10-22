import { LEARNING_SESSION_CHANNEL, type Run, TASK_SESSION_CHANNEL } from '@jian/contracts';
import type { Clock } from '../core/clock.js';
import { nowIso } from '../core/clock.js';
import type { Runs } from '../runs/service.js';
import type { Store } from '../storage/database.js';
import { listenerIsWaiting } from '../subscriptions/github-poll.js';
import { listSessionSubscriptions } from '../subscriptions/repository.js';
import { MAX_OBJECTIVE_CONTINUATIONS, objectiveAt, objectiveContinuePrompt } from './objective.js';
import { setSessionObjective } from './repository.js';
import type { Sessions } from './service.js';

/**
 * After a principal turn completes with an open session objective, queue the next slice
 * without waiting for the owner to say continue — same wake pattern as a finished subagent.
 */
export class ObjectiveContinuation {
  private deliveries?: {
    deliverRun(
      profileId: string,
      sessionId: string,
      runId: string,
      transaction: Store['db'],
    ): Promise<void>;
  };

  constructor(
    private readonly store: Store,
    private readonly sessions: Pick<Sessions, 'session'>,
    private readonly runs: Pick<Runs, 'submit'>,
    private readonly clock: Clock = Date.now,
  ) {}

  useDeliveries(deliveries: NonNullable<ObjectiveContinuation['deliveries']>) {
    this.deliveries = deliveries;
  }

  async continueAfter(run: Run): Promise<Run | null> {
    if (run.subagent || run.call) return null;

    return this.store.transaction(run.profileId, async (tx) => {
      const session = await this.sessions.session(run.profileId, run.sessionId, tx);
      if (
        session.channel === TASK_SESSION_CHANNEL ||
        session.channel === LEARNING_SESSION_CHANNEL
      ) {
        return null;
      }

      const objective = session.objective;
      if (objective?.status !== 'open') return null;

      // Listening owns resume while a watcher still expects a GitHub transition. Auto-continue
      // here only restates "still pending" on the channel; a real wake comes from poll/webhook.
      // After a subscription wake, allow slices so the agent can act on the event.
      const waiting = (await listSessionSubscriptions(tx, run.profileId, run.sessionId)).some(
        (item) => listenerIsWaiting(item, new Date(this.clock())),
      );
      if (waiting && !run.requestKey?.startsWith('subscription:')) {
        return null;
      }

      if (objective.continuations >= MAX_OBJECTIVE_CONTINUATIONS) {
        const blocked = objectiveAt(objective.text, 'blocked', nowIso(this.clock), {
          continuations: objective.continuations,
          note: `Paused after ${MAX_OBJECTIVE_CONTINUATIONS} automatic continuations. Send a message or /objective to resume.`,
        });
        await setSessionObjective(tx, run.profileId, run.sessionId, blocked);
        return null;
      }

      const next = objectiveAt(objective.text, 'open', objective.updatedAt, {
        continuations: objective.continuations + 1,
        ...(objective.note ? { note: objective.note } : {}),
      });
      await setSessionObjective(tx, run.profileId, run.sessionId, next);

      const followUp = await this.runs.submit(
        run.profileId,
        run.sessionId,
        {
          requestKey: `objective-continue:${run.id}`,
          // Summary only — never re-inject a stored shell dump or stack as the wake text.
          text: objectiveContinuePrompt(objective.text),
        },
        { transaction: tx },
      );

      await this.deliveries?.deliverRun(run.profileId, run.sessionId, followUp.id, tx);
      return followUp;
    });
  }
}

import { LEARNING_SESSION_CHANNEL, type Run, TASK_SESSION_CHANNEL } from '@jian/contracts';
import type { Clock } from '../core/clock.js';
import { nowIso } from '../core/clock.js';
import { awaitsSubagentReport } from '../runs/repository.js';
import type { Runs } from '../runs/service.js';
import type { Store } from '../storage/database.js';
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

      // A subagent's report starts the next turn when it lands. Nudging before then only has
      // the agent say it is still waiting, again and again, until the cap blocks the objective.
      if (await awaitsSubagentReport(tx, run.profileId, run.sessionId)) return null;

      if (objective.continuations >= MAX_OBJECTIVE_CONTINUATIONS) {
        const blocked = objectiveAt(objective.text, 'blocked', nowIso(this.clock), {
          continuations: objective.continuations,
          note: `Paused after ${MAX_OBJECTIVE_CONTINUATIONS} automatic continuations. Ask the agent to go on, or send /objective with the goal, to resume.`,
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
        // The gateway's nudge, not the owner's words: the agent reads it, the chat does not.
        { transaction: tx, purpose: 'resume' },
      );

      await this.deliveries?.deliverRun(run.profileId, run.sessionId, followUp.id, tx);
      return followUp;
    });
  }
}

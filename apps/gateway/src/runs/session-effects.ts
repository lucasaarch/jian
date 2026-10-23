import { type Session, TASK_SESSION_CHANNEL } from '@jian/contracts';
import { and, eq } from 'drizzle-orm';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound } from '../core/errors.js';
import { type ObjectiveCommand, objectiveAt } from '../sessions/objective.js';
import {
  type CavemanMode,
  findSession,
  type PonytailMode,
  setCavemanMode,
  setPonytailMode,
  setSessionObjective,
} from '../sessions/repository.js';
import type { Queryable } from '../storage/database.js';
import { runs } from '../storage/schema.js';

/** Internal, already-authorized ingress intent. Never infer owner authority from run.input. */
export type PendingSessionEffects = {
  ponytail?: PonytailMode;
  caveman?: CavemanMode;
  objectiveCommand?: ObjectiveCommand;
  fromPerson: boolean;
};

export async function applySessionEffects(
  tx: Queryable,
  profileId: string,
  sessionId: string,
  session: Session,
  effects: PendingSessionEffects,
  clock: Clock,
): Promise<void> {
  if (effects.ponytail) await setPonytailMode(tx, profileId, sessionId, effects.ponytail);
  if (effects.caveman) await setCavemanMode(tx, profileId, sessionId, effects.caveman);
  await applyObjective(
    tx,
    profileId,
    sessionId,
    session,
    effects.objectiveCommand,
    effects.fromPerson,
    clock,
  );
}

/** Called only after a successful admitted claim, inside its profile/fence transaction. */
export async function consumeSessionEffects(
  tx: Queryable,
  profileId: string,
  runId: string,
  sessionId: string,
  clock: Clock,
): Promise<void> {
  const [row] = await tx
    .select({ effects: runs.pendingSessionEffects })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.profileId, profileId)));
  if (!row?.effects) return;
  const session = assertFound(await findSession(tx, profileId, sessionId), 'Session');
  await applySessionEffects(tx, profileId, sessionId, session, row.effects, clock);
  await tx
    .update(runs)
    .set({ pendingSessionEffects: null })
    .where(and(eq(runs.id, runId), eq(runs.profileId, profileId)));
}

async function applyObjective(
  tx: Queryable,
  profileId: string,
  sessionId: string,
  session: Session,
  command: ObjectiveCommand | undefined,
  fromPerson: boolean,
  clock: Clock,
): Promise<void> {
  if (session.channel === TASK_SESSION_CHANNEL) return;
  const at = nowIso(clock);
  const current = session.objective;

  if (command?.action === 'set') {
    await setSessionObjective(
      tx,
      profileId,
      sessionId,
      objectiveAt(command.text, 'open', at, { continuations: 0 }),
    );
    return;
  }
  if (command?.action === 'done') {
    if (!current?.text) return;
    await setSessionObjective(
      tx,
      profileId,
      sessionId,
      objectiveAt(current.text, 'done', at, { continuations: current.continuations }),
    );
    return;
  }
  if (command?.action === 'cancel') {
    if (!current?.text) return;
    await setSessionObjective(
      tx,
      profileId,
      sessionId,
      objectiveAt(current.text, 'cancelled', at, { continuations: current.continuations }),
    );
    return;
  }

  if (!fromPerson) return;

  // Owner/channel reply while blocked: resume the same goal — never promote chat into a new title.
  if (current?.status === 'blocked' && current.text) {
    await setSessionObjective(
      tx,
      profileId,
      sessionId,
      objectiveAt(current.text, 'open', at, { continuations: 0 }),
    );
  }
}

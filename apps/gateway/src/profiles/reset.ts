import { and, eq, inArray } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { events, memories, runs, sessions } from '../storage/schema.js';

/** An answer still being written would lose the conversation it is writing into. */
export async function hasActiveRun(db: Queryable, profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.profileId, profileId), inArray(runs.status, ['queued', 'running'])))
    .limit(1);

  return row !== undefined;
}

/**
 * What the profile lived through, not what it was given. Memories are deleted explicitly: a
 * session going only clears the one it came from. Sessions take their messages, runs, checkpoints,
 * artifacts, mail, media and open questions with them; a contact keeps its approval and opens
 * a fresh conversation with its next message.
 */
export async function forget(db: Queryable, profileId: string) {
  const memoriesGone = await db
    .delete(memories)
    .where(eq(memories.profileId, profileId))
    .returning({ key: memories.key });
  const sessionsGone = await db
    .delete(sessions)
    .where(eq(sessions.profileId, profileId))
    .returning({ id: sessions.id });

  await db.delete(events).where(eq(events.profileId, profileId));

  return { sessions: sessionsGone.length, memories: memoriesGone.length };
}

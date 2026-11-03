import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { pullWatchers } from '../storage/schema.js';
import type { WatchState } from './changes.js';

export type PullWatcher = typeof pullWatchers.$inferSelect;

/** How many heads the agent pushed are remembered per pull request: past this, the oldest go. */
const OWN_SHAS = 50;

/** Opens a watcher, unless that pull request already has one. */
export async function insertWatcher(db: Queryable, row: typeof pullWatchers.$inferInsert) {
  await db.insert(pullWatchers).values(row).onConflictDoNothing();
}

/**
 * The conversation the owner asked in, for a run: its own, or, for a subagent's, the one at the
 * top of the chain of runs that started it.
 */
export async function rootSessionOf(
  db: Queryable,
  profileId: string,
  runId: string,
): Promise<string | undefined> {
  const result = await db.execute(sql`
    with recursive chain(id, session_id, parent, depth) as (
      select id, session_id, subagent->>'parentRunId', 0 from runs
      where id = ${runId} and profile_id = ${profileId}
      union all
      select runs.id, runs.session_id, runs.subagent->>'parentRunId', chain.depth + 1
      from runs join chain on runs.id::text = chain.parent
      where runs.profile_id = ${profileId} and chain.depth < 20
    )
    select session_id from chain order by depth desc limit 1
  `);
  // Both drivers, node-postgres and PGlite, answer a raw query with its rows under `rows`.
  const { rows } = result as unknown as { rows: { session_id: string }[] };
  return rows[0]?.session_id;
}

/** Watchers whose next look is due, the longest waiting first. */
export async function dueWatchers(db: Queryable, now: Date, limit: number) {
  return db
    .select()
    .from(pullWatchers)
    .where(and(eq(pullWatchers.status, 'watching'), lte(pullWatchers.nextPollAt, now)))
    .orderBy(asc(pullWatchers.nextPollAt))
    .limit(limit);
}

/**
 * Takes a watcher's next look, moving it to `until` so no other worker takes it meanwhile.
 * Undefined when another worker took it first: its version moved.
 */
export async function claimWatcher(
  db: Queryable,
  watcher: PullWatcher,
  until: Date,
): Promise<PullWatcher | undefined> {
  const [claimed] = await db
    .update(pullWatchers)
    .set({ version: watcher.version + 1, nextPollAt: until })
    .where(
      and(
        eq(pullWatchers.id, watcher.id),
        eq(pullWatchers.version, watcher.version),
        eq(pullWatchers.status, 'watching'),
      ),
    )
    .returning();
  return claimed;
}

/** Writes what a look found, only if no other worker took a look since; false when one did. */
export async function saveWatcher(
  db: Queryable,
  watcher: PullWatcher,
  patch: Partial<{
    status: PullWatcher['status'];
    endedReason: string | null;
    state: WatchState;
    nextPollAt: Date;
    failingSince: Date | null;
  }>,
  now: Date,
): Promise<boolean> {
  const saved = await db
    .update(pullWatchers)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(pullWatchers.id, watcher.id), eq(pullWatchers.version, watcher.version)))
    .returning({ id: pullWatchers.id });
  return saved.length > 0;
}

/**
 * Remembers a head the agent pushed itself, on every watched pull request of that repository
 * whose branch it is, or whose branch is not known yet.
 */
export async function rememberOwnPush(
  db: Queryable,
  profileId: string,
  pull: { owner: string; repo: string; branch: string; sha: string },
) {
  await db
    .update(pullWatchers)
    .set({
      ownShas: sql`(
        select coalesce(jsonb_agg(sha), '[]'::jsonb) from (
          select sha from jsonb_array_elements_text(${pullWatchers.ownShas} || ${JSON.stringify([pull.sha])}::jsonb)
            with ordinality as kept(sha, place)
          order by place desc limit ${OWN_SHAS}
        ) as recent
      )`,
    })
    .where(
      and(
        eq(pullWatchers.profileId, profileId),
        eq(pullWatchers.status, 'watching'),
        sql`lower(${pullWatchers.owner}) = lower(${pull.owner})`,
        sql`lower(${pullWatchers.repo}) = lower(${pull.repo})`,
        sql`coalesce(${pullWatchers.state}->>'headRef', ${pull.branch}) = ${pull.branch}`,
      ),
    );
}

/** The watchers of a conversation's pull requests, whatever their state. */
export async function watchersOfSession(db: Queryable, profileId: string, sessionId: string) {
  return db
    .select({
      owner: pullWatchers.owner,
      repo: pullWatchers.repo,
      number: pullWatchers.number,
      status: pullWatchers.status,
      endedReason: pullWatchers.endedReason,
    })
    .from(pullWatchers)
    .where(and(eq(pullWatchers.profileId, profileId), eq(pullWatchers.sessionId, sessionId)));
}

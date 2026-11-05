import { randomUUID } from 'node:crypto';
import type { SessionWorktree } from '@jian/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import type { Queryable } from '../storage/database.js';
import { profiles, runs, sessions, sessionWorktrees } from '../storage/schema.js';

/** A worktree as recorded, before anyone has looked at the disk. */
export type WorktreeRecord = Omit<
  SessionWorktree,
  'ahead' | 'behind' | 'uncommitted' | 'pullRequest'
> & { id: string };

const columns = {
  id: sessionWorktrees.id,
  name: sessionWorktrees.name,
  branch: sessionWorktrees.branch,
  base: sessionWorktrees.base,
  source: sessionWorktrees.source,
  path: sessionWorktrees.path,
  place: sessionWorktrees.place,
};

/** Every query names both the profile and the conversation: a row is never found by id alone. */
const mine = (profileId: string, sessionId: string) =>
  and(eq(sessionWorktrees.profileId, profileId), eq(sessionWorktrees.sessionId, sessionId));

const asRecord = (row: Record<keyof typeof columns, string>) => row as WorktreeRecord;

export async function activeWorktrees(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<WorktreeRecord[]> {
  const rows = await db
    .select(columns)
    .from(sessionWorktrees)
    .where(and(mine(profileId, sessionId), isNull(sessionWorktrees.removedAt)))
    .orderBy(sessionWorktrees.createdAt);
  return rows.map(asRecord);
}

export async function insertWorktree(
  db: Queryable,
  clock: Clock,
  profileId: string,
  sessionId: string,
  input: Omit<WorktreeRecord, 'id'>,
): Promise<WorktreeRecord> {
  const id = randomUUID();
  await db
    .insert(sessionWorktrees)
    .values({ id, profileId, sessionId, ...input, createdAt: new Date(clock()) });
  return { id, ...input };
}

/** True only for the call that changed the row, so a removal is announced once. */
export async function markRemoved(
  db: Queryable,
  clock: Clock,
  profileId: string,
  sessionId: string,
  id: string,
): Promise<boolean> {
  const done = await db
    .update(sessionWorktrees)
    .set({ removedAt: new Date(clock()) })
    .where(
      and(
        mine(profileId, sessionId),
        eq(sessionWorktrees.id, id),
        isNull(sessionWorktrees.removedAt),
      ),
    )
    .returning({ id: sessionWorktrees.id });
  return done.length > 0;
}

type Candidate = {
  sessionId: string;
  profileId: string;
  title: string | null;
  profileName: string;
  folders: string[];
};

/**
 * Conversations other than `sessionId` with a run under way. Subagent runs are left out: their
 * parent run is open for as long as they are, and the parent names the conversation.
 */
export async function openConversations(db: Queryable, sessionId: string): Promise<Candidate[]> {
  const rows = await db
    .selectDistinct({
      sessionId: sessions.id,
      profileId: sessions.profileId,
      title: sessions.title,
      profileName: profiles.name,
      workspace: sessions.workspace,
    })
    .from(runs)
    .innerJoin(sessions, eq(sessions.id, runs.sessionId))
    .innerJoin(profiles, eq(profiles.id, sessions.profileId))
    .where(and(inArray(runs.status, ['queued', 'running', 'waiting']), isNull(runs.subagent)));
  return rows
    .filter((row) => row.sessionId !== sessionId)
    .map(({ workspace, ...row }) => ({ ...row, folders: workspace?.folders ?? [] }));
}

/** Which conversations hold a live worktree of each source, across every profile. */
export async function worktreeHolders(
  db: Queryable,
  sources: string[],
): Promise<{ sessionId: string; source: string }[]> {
  if (sources.length === 0) return [];
  return db
    .select({ sessionId: sessionWorktrees.sessionId, source: sessionWorktrees.source })
    .from(sessionWorktrees)
    .where(and(inArray(sessionWorktrees.source, sources), isNull(sessionWorktrees.removedAt)));
}

/**
 * The conversation and the task sessions of the subagents it started, however deep. A subagent's
 * worktrees belong to its own task session, and deleting the conversation does not remove that
 * session, so they have to be found before the conversation's runs are gone.
 */
export async function conversationAndSubagentSessions(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<string[]> {
  const found = new Set([sessionId]);
  let frontier = [sessionId];

  while (frontier.length > 0) {
    const parents = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.profileId, profileId), inArray(runs.sessionId, frontier)));
    if (parents.length === 0) break;
    const children = await db
      .selectDistinct({ sessionId: runs.sessionId })
      .from(runs)
      .where(
        and(
          eq(runs.profileId, profileId),
          inArray(
            sql`(${runs.subagent}->>'parentRunId')`,
            parents.map((run) => run.id),
          ),
        ),
      );
    frontier = children.map((run) => run.sessionId).filter((id) => !found.has(id));
    for (const id of frontier) found.add(id);
  }
  return [...found];
}

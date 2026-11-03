import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { sessionLoads } from '../storage/schema.js';

/** `workspace` is a folder the conversation cloned into, as `<location>|<path>`. */
export type LoadKind = 'skill' | 'tool' | 'mcp' | 'workspace';
export type SessionLoad = typeof sessionLoads.$inferSelect;

/** What a conversation keeps loaded, in the order it was loaded. */
export async function listLoads(db: Queryable, profileId: string, sessionId: string) {
  return db
    .select()
    .from(sessionLoads)
    .where(and(eq(sessionLoads.profileId, profileId), eq(sessionLoads.sessionId, sessionId)))
    .orderBy(asc(sessionLoads.loadedAt), asc(sessionLoads.name));
}

/**
 * Records `names` as loaded, or as used again when they already are: a load the conversation
 * keeps, and a use that keeps it through the next compaction.
 */
export async function useLoads(
  db: Queryable,
  scope: { profileId: string; sessionId: string },
  kind: LoadKind,
  names: readonly string[],
  now: Date,
) {
  if (!names.length) return;
  await db
    .insert(sessionLoads)
    .values(
      [...new Set(names)].map((name) => ({
        ...scope,
        kind,
        name,
        loadedAt: now,
        usedAt: now,
        usedSinceCompaction: true,
      })),
    )
    .onConflictDoUpdate({
      target: [sessionLoads.sessionId, sessionLoads.kind, sessionLoads.name],
      set: { usedAt: now, usedSinceCompaction: true },
    });
}

/** Whether the conversation already keeps `name` loaded. */
export async function isLoaded(
  db: Queryable,
  scope: { profileId: string; sessionId: string },
  kind: LoadKind,
  name: string,
) {
  const [row] = await db
    .select({ name: sessionLoads.name })
    .from(sessionLoads)
    .where(
      and(
        eq(sessionLoads.profileId, scope.profileId),
        eq(sessionLoads.sessionId, scope.sessionId),
        eq(sessionLoads.kind, kind),
        eq(sessionLoads.name, name),
      ),
    );
  return Boolean(row);
}

/** Forgets loads the conversation can no longer keep. */
export async function dropLoads(
  db: Queryable,
  scope: { profileId: string; sessionId: string },
  kind: LoadKind,
  names: readonly string[],
) {
  if (!names.length) return;
  await db
    .delete(sessionLoads)
    .where(
      and(
        eq(sessionLoads.profileId, scope.profileId),
        eq(sessionLoads.sessionId, scope.sessionId),
        eq(sessionLoads.kind, kind),
        inArray(sessionLoads.name, [...names]),
      ),
    );
}

/**
 * At a compaction: what was not used since the one before goes, and what stays starts over, so
 * the next compaction asks the same of it.
 */
export async function compactLoads(db: Queryable, sessionId: string) {
  // A folder the conversation cloned into is where it works, used or not: it stays.
  await db
    .delete(sessionLoads)
    .where(
      and(
        eq(sessionLoads.sessionId, sessionId),
        eq(sessionLoads.usedSinceCompaction, false),
        sql`${sessionLoads.kind} <> 'workspace'`,
      ),
    );
  await db
    .update(sessionLoads)
    .set({ usedSinceCompaction: sql`false` })
    .where(eq(sessionLoads.sessionId, sessionId));
}

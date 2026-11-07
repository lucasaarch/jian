import type { GatewayEvent, RunProgress } from '@jian/contracts';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { events, runs } from '../storage/schema.js';

/** How many events one read returns at most. */
export const EVENTS_PAGE = 100;

/** Everything a profile recorded after a cursor, oldest first, so a client can resume. */
export async function readEvents(
  db: Queryable,
  profileId: string,
  after: number,
  limit = EVENTS_PAGE,
): Promise<GatewayEvent[]> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.profileId, profileId), gt(events.id, after)))
    .orderBy(asc(events.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    profileId: row.profileId,
    ...(row.runId ? { runId: row.runId } : {}),
    type: row.type,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** The cursor at the end of a profile's feed: 0 while it has recorded nothing. */
export async function latestEventId(db: Queryable, profileId: string): Promise<number> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.profileId, profileId))
    .orderBy(desc(events.id))
    .limit(1);

  return row?.id ?? 0;
}

/** The runs of a profile at work now, with when their progress last changed. */
export async function readProgress(
  db: Queryable,
  profileId: string,
): Promise<Array<{ runId: string; sessionId: string; at: string; progress: RunProgress | null }>> {
  const rows = await db
    .select({
      runId: runs.id,
      sessionId: runs.sessionId,
      at: sql<string | null>`${runs.progress}->>'updatedAt'`,
      progress: runs.progress,
      status: runs.status,
    })
    .from(runs)
    .where(and(eq(runs.profileId, profileId), inArray(runs.status, ['queued', 'running'])));

  return rows.map((row) => ({
    runId: row.runId,
    sessionId: row.sessionId,
    at: row.at ?? row.status,
    progress: row.progress,
  }));
}

import type { GatewayEvent } from '@jian/contracts';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { events, runs } from '../storage/schema.js';

/** Everything a profile recorded after a cursor, oldest first, so a client can resume. */
export async function readEvents(
  db: Queryable,
  profileId: string,
  after: number,
  limit = 100,
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

/** The runs of a profile at work now, with when their progress last changed. */
export async function readProgress(
  db: Queryable,
  profileId: string,
): Promise<Array<{ runId: string; sessionId: string; at: string }>> {
  const rows = await db
    .select({
      runId: runs.id,
      sessionId: runs.sessionId,
      at: sql<string | null>`${runs.progress}->>'updatedAt'`,
      status: runs.status,
    })
    .from(runs)
    .where(and(eq(runs.profileId, profileId), inArray(runs.status, ['queued', 'running'])));

  return rows.map((row) => ({
    runId: row.runId,
    sessionId: row.sessionId,
    at: row.at ?? row.status,
  }));
}

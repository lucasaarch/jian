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

/** The one event a client acts on by itself, whose few short fields a stream tells whole. */
const FOCUS_EVENT = 'conversation.inspector.focus';

/**
 * The same page as `readEvents`, as a stream tells it: that each event happened and which
 * conversation it concerns, which is what a client needs to read that conversation again. A
 * step's data holds tool inputs and diffs of any size, read here by every open stream, so it
 * stays in the database. The whole event stays in the paged feed.
 */
export async function readEventHeads(
  db: Queryable,
  profileId: string,
  after: number,
  limit = EVENTS_PAGE,
): Promise<GatewayEvent[]> {
  const rows = await db
    .select({
      id: events.id,
      profileId: events.profileId,
      runId: events.runId,
      type: events.type,
      sessionId: sql<unknown>`${events.data}->'sessionId'`,
      parentSessionId: sql<unknown>`${events.data}->'parentSessionId'`,
      focus: sql<unknown>`case when ${events.type} = ${FOCUS_EVENT} then ${events.data} end`,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(and(eq(events.profileId, profileId), gt(events.id, after)))
    .orderBy(asc(events.id))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    profileId: row.profileId,
    ...(row.runId ? { runId: row.runId } : {}),
    type: row.type,
    data:
      row.type === FOCUS_EVENT
        ? row.focus
        : {
            ...(row.sessionId ? { sessionId: row.sessionId } : {}),
            ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
          },
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

/** When a run's progress last changed; a run that has not reported yet reads as its status. */
const progressStamp = sql<string>`coalesce(${runs.progress}->>'updatedAt', ${runs.status}::text)`;

/**
 * The runs of a profile at work now, with when their progress last changed. Every commit wakes
 * every stream of the profile, and a run's progress can carry a whole Artifact being written, so
 * this is what a stream reads each time to learn whether there is anything to tell.
 */
export async function readProgressStamps(
  db: Queryable,
  profileId: string,
): Promise<Array<{ runId: string; sessionId: string; at: string }>> {
  return db
    .select({ runId: runs.id, sessionId: runs.sessionId, at: progressStamp })
    .from(runs)
    .where(and(eq(runs.profileId, profileId), inArray(runs.status, ['queued', 'running'])));
}

/** The progress of these runs, those still at work, for a stream that was told they moved. */
export async function readRunsProgress(
  db: Queryable,
  profileId: string,
  runIds: string[],
): Promise<Array<{ runId: string; sessionId: string; at: string; progress: RunProgress | null }>> {
  if (!runIds.length) return [];
  return db
    .select({
      runId: runs.id,
      sessionId: runs.sessionId,
      at: progressStamp,
      progress: runs.progress,
    })
    .from(runs)
    .where(
      and(
        eq(runs.profileId, profileId),
        inArray(runs.id, runIds),
        inArray(runs.status, ['queued', 'running']),
      ),
    );
}

import type { Schedule, ScheduleRun } from '@jian/contracts';
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { runs, scheduleRuns, schedules } from '../storage/schema.js';

type Row = typeof schedules.$inferSelect;

export function toSchedule(row: Row): Schedule {
  return {
    id: row.id,
    profileId: row.profileId,
    name: row.name,
    instruction: row.instruction,
    sessionId: row.sessionId,
    ...(row.at ? { at: row.at.toISOString() } : {}),
    ...(row.cron ? { cron: row.cron } : {}),
    timeZone: row.timeZone,
    enabled: row.enabled,
    ...(row.nextRunAt ? { nextRunAt: row.nextRunAt.toISOString() } : {}),
    ...(row.lastRunAt ? { lastRunAt: row.lastRunAt.toISOString() } : {}),
    ...(row.lastRunId ? { lastRunId: row.lastRunId } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRow(schedule: Schedule): typeof schedules.$inferInsert {
  return {
    id: schedule.id,
    profileId: schedule.profileId,
    sessionId: schedule.sessionId,
    name: schedule.name,
    instruction: schedule.instruction,
    at: schedule.at ? new Date(schedule.at) : null,
    cron: schedule.cron ?? null,
    timeZone: schedule.timeZone,
    enabled: schedule.enabled,
    nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt) : null,
    lastRunAt: schedule.lastRunAt ? new Date(schedule.lastRunAt) : null,
    lastRunId: schedule.lastRunId ?? null,
    lastError: schedule.lastError ?? null,
    createdBy: schedule.createdBy,
    createdAt: new Date(schedule.createdAt),
    updatedAt: new Date(schedule.updatedAt),
  };
}

export async function listSchedules(db: Queryable, profileId: string): Promise<Schedule[]> {
  const rows = await db
    .select()
    .from(schedules)
    .where(eq(schedules.profileId, profileId))
    .orderBy(asc(schedules.createdAt));

  return rows.map(toSchedule);
}

export async function findSchedule(
  db: Queryable,
  profileId: string,
  id: string,
): Promise<Schedule | null> {
  const [row] = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.profileId, profileId), eq(schedules.id, id)))
    .limit(1);

  return row ? toSchedule(row) : null;
}

export async function insertSchedule(db: Queryable, schedule: Schedule) {
  await db.insert(schedules).values(toRow(schedule));
}

export async function replaceSchedule(db: Queryable, schedule: Schedule) {
  await db.update(schedules).set(toRow(schedule)).where(eq(schedules.id, schedule.id));
}

export async function deleteSchedule(db: Queryable, profileId: string, id: string) {
  await db.delete(schedules).where(and(eq(schedules.profileId, profileId), eq(schedules.id, id)));
}

/** Every switched-on schedule whose time has come, across profiles, oldest due first. */
export async function dueSchedules(db: Queryable, now: Date, limit = 50): Promise<Schedule[]> {
  const rows = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.enabled, true),
        isNotNull(schedules.nextRunAt),
        lte(schedules.nextRunAt, now),
      ),
    )
    .orderBy(asc(schedules.nextRunAt))
    .limit(limit);

  return rows.map(toSchedule);
}

/**
 * Moves a schedule past the time it just ran for, only if nobody moved it first: two workers
 * that picked the same schedule both start the same run, and only one of them advances it.
 */
export async function advanceSchedule(
  db: Queryable,
  schedule: Schedule,
  dueAt: Date,
  next: { nextRunAt: Date | null; enabled: boolean; lastRunId?: string; lastError?: string },
  now: Date,
): Promise<boolean> {
  const moved = await db
    .update(schedules)
    .set({
      nextRunAt: next.nextRunAt,
      enabled: next.enabled,
      lastRunAt: now,
      lastRunId: next.lastRunId ?? null,
      lastError: next.lastError ?? null,
      updatedAt: now,
    })
    .where(and(eq(schedules.id, schedule.id), eq(schedules.nextRunAt, dueAt)))
    .returning({ id: schedules.id });

  return moved.length > 0;
}

export async function recordScheduleRun(
  db: Queryable,
  entry: {
    id: string;
    scheduleId: string;
    profileId: string;
    dueAt: Date;
    manual: boolean;
    runId?: string | undefined;
    error?: string | undefined;
    /** The gateway's clock, not the database's: history ages by the same time it is due by. */
    createdAt: Date;
  },
) {
  await db
    .insert(scheduleRuns)
    .values({ ...entry, runId: entry.runId ?? null, error: entry.error ?? null })
    .onConflictDoNothing();
}

/** A schedule's runs since `since`, newest first, with how each run went. */
export async function scheduleHistory(
  db: Queryable,
  profileId: string,
  scheduleId: string,
  since: Date,
): Promise<ScheduleRun[]> {
  const rows = await db
    .select({ entry: scheduleRuns, status: runs.status, runError: runs.error })
    .from(scheduleRuns)
    .leftJoin(runs, eq(runs.id, scheduleRuns.runId))
    .where(
      and(
        eq(scheduleRuns.profileId, profileId),
        eq(scheduleRuns.scheduleId, scheduleId),
        gte(scheduleRuns.createdAt, since),
      ),
    )
    .orderBy(desc(scheduleRuns.createdAt), desc(scheduleRuns.dueAt));

  return rows.map(({ entry, status, runError }) => ({
    id: entry.id,
    dueAt: entry.dueAt.toISOString(),
    manual: entry.manual,
    ...(entry.runId ? { runId: entry.runId } : {}),
    ...(status ? { status } : {}),
    ...(entry.error || runError ? { error: (entry.error ?? runError) as string } : {}),
    createdAt: entry.createdAt.toISOString(),
  }));
}

/**
 * Forgets what has served its purpose: history older than `historyBefore`, and single-time
 * schedules that ran before `doneBefore`.
 */
export async function pruneSchedules(db: Queryable, historyBefore: Date, doneBefore: Date) {
  await db.delete(scheduleRuns).where(lt(scheduleRuns.createdAt, historyBefore));
  await db
    .delete(schedules)
    .where(
      and(
        isNull(schedules.cron),
        eq(schedules.enabled, false),
        isNotNull(schedules.lastRunAt),
        lt(schedules.lastRunAt, doneBefore),
      ),
    );
}

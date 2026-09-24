import type { RunTimeline, ToolStep } from '@jian/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { checkpoints, runs } from '../storage/schema.js';

/** How many recent turns a timeline covers; older answers show without their tools. */
const TIMELINE_RUNS = 50;
const phases = ['tool-started', 'step-completed', 'tool-failed', 'tool-refused', 'tool-uncertain'];

/**
 * The tools of each recent turn of a conversation, rebuilt from the checkpoints the runtime
 * writes. Only the fields a timeline needs leave the database: a step's checkpoint also holds
 * the whole prompt and every result, far too much to read for this.
 */
export async function sessionTimeline(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<RunTimeline[]> {
  const recent = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.profileId, profileId), eq(runs.sessionId, sessionId)))
    .orderBy(desc(runs.createdAt))
    .limit(TIMELINE_RUNS);

  if (!recent.length) return [];

  const rows = await db
    .select({
      runId: checkpoints.runId,
      at: checkpoints.createdAt,
      phase: sql<string>`${checkpoints.data}->>'phase'`,
      toolName: sql<string | null>`${checkpoints.data}->>'toolName'`,
      toolCallId: sql<string | null>`${checkpoints.data}->>'toolCallId'`,
      // Only the ids: the results beside them can be large, and the timeline does not show them.
      tools: sql<
        string[] | null
      >`jsonb_path_query_array(${checkpoints.data}, '$.tools[*].toolCallId')`,
      reason: sql<string | null>`${checkpoints.data}->>'reason'`,
    })
    .from(checkpoints)
    .where(
      and(
        eq(checkpoints.profileId, profileId),
        inArray(
          checkpoints.runId,
          recent.map((run) => run.id),
        ),
        inArray(sql`${checkpoints.data}->>'phase'`, phases),
      ),
    )
    .orderBy(asc(checkpoints.createdAt), asc(checkpoints.id));

  const active = new Set(
    recent
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .map((run) => run.id),
  );
  const timelines = new Map<string, Map<string, ToolStep>>();

  for (const row of rows) {
    const steps = timelines.get(row.runId) ?? new Map<string, ToolStep>();

    timelines.set(row.runId, steps);

    if (row.phase === 'tool-started' && row.toolCallId && row.toolName) {
      steps.set(row.toolCallId, {
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        status: 'running',
        startedAt: row.at.toISOString(),
      });
      continue;
    }

    if (row.phase === 'step-completed') {
      for (const toolCallId of row.tools ?? []) {
        const step = steps.get(toolCallId);

        if (step?.status === 'running') {
          Object.assign(step, { status: 'done', finishedAt: row.at.toISOString() });
        }
      }
      continue;
    }

    const step = row.toolCallId ? steps.get(row.toolCallId) : undefined;

    if (step) {
      Object.assign(step, {
        status:
          row.phase === 'tool-failed'
            ? 'failed'
            : row.phase === 'tool-refused'
              ? 'refused'
              : 'uncertain',
        finishedAt: row.at.toISOString(),
        ...(row.reason ? { error: row.reason } : {}),
      });
    }
  }

  return recent
    .filter((run) => timelines.get(run.id)?.size)
    .reverse()
    .map((run) => ({
      runId: run.id,
      steps: [...(timelines.get(run.id)?.values() ?? [])].map((step) =>
        // A tool still "running" in a turn that ended never came back.
        step.status === 'running' && !active.has(run.id) ? { ...step, status: 'stopped' } : step,
      ),
    }));
}

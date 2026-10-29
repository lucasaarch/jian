import { codeDiffSchema, type RunTimeline, type ToolStep } from '@jian/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { checkpoints, runs } from '../storage/schema.js';

/** How many recent turns a timeline covers; older answers show without their tools. */
const TIMELINE_RUNS = 50;
const phases = [
  'tool-started',
  'step-completed',
  'tool-failed',
  'tool-refused',
  'tool-uncertain',
  'tool-diff',
  'tool-completed',
];

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
    .select({
      id: runs.id,
      status: runs.status,
      approval: runs.approval,
      question: runs.question,
    })
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
      // Only a write's own diff checkpoint carries one; every other row reads null here.
      diff: sql<unknown>`${checkpoints.data}->'diff'`,
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

    if (row.phase === 'tool-diff') {
      const step = row.toolCallId ? steps.get(row.toolCallId) : undefined;
      // Read back as the contract states it: a row written by another version is dropped,
      // never passed through.
      const diff = codeDiffSchema.safeParse(row.diff);

      if (step && diff.success) step.diff = diff.data;
      continue;
    }

    // An approved action runs ahead of the turn's first step and closes itself.
    if (row.phase === 'tool-completed') {
      const step = row.toolCallId ? steps.get(row.toolCallId) : undefined;

      if (step?.status === 'running') {
        Object.assign(step, { status: 'done', finishedAt: row.at.toISOString() });
      }
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

  // A turn that asked for approval or put a question belongs here even with no tool run: the
  // panel places its card where the turn sits in the conversation.
  return recent
    .filter((run) => timelines.get(run.id)?.size || run.approval || run.question)
    .reverse()
    .map((run) => ({
      runId: run.id,
      steps: [...(timelines.get(run.id)?.values() ?? [])].map((step) =>
        // A tool still "running" in a turn that ended never came back.
        step.status === 'running' && !active.has(run.id) ? { ...step, status: 'stopped' } : step,
      ),
      ...(run.approval ? { approval: run.approval } : {}),
      ...(run.question ? { question: run.question } : {}),
    }));
}

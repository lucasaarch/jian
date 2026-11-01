import {
  codeDiffSchema,
  imageAspectSchema,
  type RunTimeline,
  TOOL_DISPLAY_CHARS,
  type ToolStep,
} from '@jian/contracts';
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

/** The database has already cut oversized JSON; never fetch the prompt or full artifacts. */
function display(field: 'input' | 'output', value: string | null): Partial<ToolStep> {
  if (value === null) return {};
  let text = value;
  if (value.length <= TOOL_DISPLAY_CHARS) {
    try {
      const parsed: unknown = JSON.parse(value);
      text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
    } catch {
      // An old or already-cut checkpoint is still useful as display text.
    }
  }
  return {
    [field]: text.slice(0, TOOL_DISPLAY_CHARS),
    ...(text.length > TOOL_DISPLAY_CHARS ? { [`${field}Truncated`]: true } : {}),
  };
}

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
      // These fields were redacted at write time. Bound them in SQL, before they leave the DB.
      input: sql<
        string | null
      >`left((${checkpoints.data}->'input')::text, ${TOOL_DISPLAY_CHARS + 1})`,
      output: sql<
        string | null
      >`left((${checkpoints.data}->'result')::text, ${TOOL_DISPLAY_CHARS + 1})`,
      tools: sql<Array<{ toolCallId: string; toolName: string; output: string | null }> | null>`(
        select jsonb_agg(jsonb_build_object(
          'toolCallId', item->>'toolCallId',
          'toolName', item->>'toolName',
          'output', left((item->'result')::text, ${TOOL_DISPLAY_CHARS + 1})
        )) from jsonb_array_elements(
          case when jsonb_typeof(${checkpoints.data}->'tools') = 'array'
          then ${checkpoints.data}->'tools' else '[]'::jsonb end
        ) as item
      )`,
      reason: sql<
        string | null
      >`left(coalesce(${checkpoints.data}->>'detail', ${checkpoints.data}->>'reason'), ${TOOL_DISPLAY_CHARS})`,
      // Only a write's own diff checkpoint carries one; every other row reads null here.
      diff: sql<unknown>`${checkpoints.data}->'diff'`,
      // Only an image being drawn is asked for one; every other row reads null here.
      aspectRatio: sql<string | null>`${checkpoints.data}->'input'->>'aspectRatio'`,
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
      const aspect =
        row.toolName === 'generate_image'
          ? imageAspectSchema.safeParse(row.aspectRatio ?? '1:1')
          : undefined;
      steps.set(row.toolCallId, {
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        status: 'running',
        startedAt: row.at.toISOString(),
        ...display('input', row.input),
        ...(aspect?.success ? { aspectRatio: aspect.data } : {}),
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

      if (step && step.toolName === row.toolName) {
        Object.assign(step, display('output', row.output));
        if (step.status === 'running') {
          Object.assign(step, { status: 'done', finishedAt: row.at.toISOString() });
        }
      }
      continue;
    }

    if (row.phase === 'step-completed') {
      for (const result of row.tools ?? []) {
        const step = steps.get(result.toolCallId);
        if (!step || step.toolName !== result.toolName) continue;
        Object.assign(step, display('output', result.output));
        if (step.status === 'running') {
          Object.assign(step, { status: 'done', finishedAt: row.at.toISOString() });
        }
      }
      continue;
    }

    const step = row.toolCallId ? steps.get(row.toolCallId) : undefined;

    if (step && step.toolName === row.toolName) {
      Object.assign(step, {
        status:
          row.phase === 'tool-failed'
            ? 'failed'
            : row.phase === 'tool-refused'
              ? 'refused'
              : 'uncertain',
        finishedAt: row.at.toISOString(),
        ...display('output', row.output),
        ...(row.reason ? { error: row.reason.slice(0, TOOL_DISPLAY_CHARS) } : {}),
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

import {
  codeDiffSchema,
  imageAspectSchema,
  mcpToolRefSchema,
  type RunTimeline,
  TOOL_DISPLAY_CHARS,
  type ToolStep,
} from '@jian/contracts';
import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { checkpoints, runs } from '../storage/schema.js';
import { previewJson } from './json-preview.js';

/** How many recent turns a timeline covers when it is not told which. */
const TIMELINE_RUNS = 50;
/** How many turns one read may name: more than a page of messages can belong to. */
const NAMED_RUNS = 200;
const phases = [
  'tool-started',
  'step-completed',
  'tool-failed',
  'tool-refused',
  'tool-uncertain',
  'tool-diff',
  'tool-completed',
];

/** How much of a tool's input and output a brief timeline gives, in characters, laid out. */
export const BRIEF_CHARS = 240;

/**
 * How much a value is shown, and how much of its JSON the database sends to show it, in
 * characters. A brief read takes a few times the preview, so the layout, which only adds
 * characters, and a string's escapes, which take two for one, still fill it.
 */
type Bound = { show: number; read: number };
const FULL: Bound = { show: TOOL_DISPLAY_CHARS, read: TOOL_DISPLAY_CHARS };
const BRIEF: Bound = { show: BRIEF_CHARS, read: BRIEF_CHARS * 4 };

/** The database has already cut oversized JSON; never fetch the prompt or full artifacts. */
function display(
  field: 'input' | 'output',
  value: string | null,
  bound: Bound = FULL,
): Partial<ToolStep> {
  if (value === null) return {};
  // The database sends one character more than it was asked to read when it cut the value.
  const whole = value.length <= bound.read;
  let text = value;
  if (whole) {
    try {
      const parsed: unknown = JSON.parse(value);
      text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
    } catch {
      // An old or already-cut checkpoint is still useful as display text.
    }
  } else if (bound === BRIEF) {
    // A full read shows a value too long to parse as it stands; a preview is laid out anyway.
    text = previewJson(value.slice(0, bound.read));
  }
  return {
    [field]: text.slice(0, bound.show),
    ...(!whole || text.length > bound.show ? { [`${field}Truncated`]: true } : {}),
  };
}

/**
 * A diff's hunks without their lines, for a brief read: the starts, counts and headers say
 * where a write landed, and the lines, the weight of it, stay in the database. Whether any
 * hunk had lines tells whether the step was cut.
 */
function briefDiff(diff: SQL) {
  const hunks = sql`case when jsonb_typeof(${diff}->'hunks') = 'array'
    then ${diff}->'hunks' else '[]'::jsonb end`;
  return {
    diff: sql<unknown>`case when jsonb_typeof(${diff}->'hunks') = 'array'
      then jsonb_set(${diff}, '{hunks}', coalesce((
        select jsonb_agg(case when jsonb_typeof(hunk) = 'object'
          then hunk || '{"lines": []}'::jsonb else hunk end)
        from jsonb_array_elements(${diff}->'hunks') as hunk
      ), '[]'::jsonb))
      else ${diff} end`,
    diffLines: sql<boolean | null>`(
      select bool_or(case when jsonb_typeof(hunk->'lines') = 'array'
        then jsonb_array_length(hunk->'lines') > 0 else false end)
      from jsonb_array_elements(${hunks}) as hunk
    )`,
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
  /** The turns to read, however old; only those of this conversation are ever read. */
  runIds?: string[],
  /** `brief`: each tool as a list shows it, marked `brief` when it was cut. */
  options: { brief?: boolean } = {},
): Promise<RunTimeline[]> {
  if (runIds && !runIds.length) return [];
  const bound = options.brief ? BRIEF : FULL;
  // One more than is read, so a value the database cut is told from one that just fits.
  const read = bound.read + 1;
  const diff = sql`${checkpoints.data}->'diff'`;

  const recent = await db
    .select({
      id: runs.id,
      status: runs.status,
      approval: runs.approval,
      question: runs.question,
    })
    .from(runs)
    .where(
      and(
        eq(runs.profileId, profileId),
        eq(runs.sessionId, sessionId),
        runIds ? inArray(runs.id, runIds.slice(0, NAMED_RUNS)) : undefined,
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(runIds ? NAMED_RUNS : TIMELINE_RUNS);

  if (!recent.length) return [];

  const rows = await db
    .select({
      runId: checkpoints.runId,
      at: checkpoints.createdAt,
      phase: sql<string>`${checkpoints.data}->>'phase'`,
      toolName: sql<string | null>`${checkpoints.data}->>'toolName'`,
      toolCallId: sql<string | null>`${checkpoints.data}->>'toolCallId'`,
      // Only a tool server's call carries one; every other row reads null here.
      mcp: sql<unknown>`${checkpoints.data}->'mcp'`,
      // These fields were redacted at write time. Bound them in SQL, before they leave the DB.
      input: sql<string | null>`left((${checkpoints.data}->'input')::text, ${read})`,
      output: sql<string | null>`left((${checkpoints.data}->'result')::text, ${read})`,
      tools: sql<Array<{ toolCallId: string; toolName: string; output: string | null }> | null>`(
        select jsonb_agg(jsonb_build_object(
          'toolCallId', item->>'toolCallId',
          'toolName', item->>'toolName',
          'output', left((item->'result')::text, ${read})
        )) from jsonb_array_elements(
          case when jsonb_typeof(${checkpoints.data}->'tools') = 'array'
          then ${checkpoints.data}->'tools' else '[]'::jsonb end
        ) as item
      )`,
      reason: sql<
        string | null
      >`left(coalesce(${checkpoints.data}->>'detail', ${checkpoints.data}->>'reason'), ${TOOL_DISPLAY_CHARS})`,
      // Only a write's own diff checkpoint carries one; every other row reads null here.
      ...(options.brief
        ? briefDiff(diff)
        : { diff: sql<unknown>`${diff}`, diffLines: sql<boolean | null>`null` }),
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
  // The steps whose diff lost its lines to a brief read.
  const linesCut = new Set<ToolStep>();

  for (const row of rows) {
    const steps = timelines.get(row.runId) ?? new Map<string, ToolStep>();

    timelines.set(row.runId, steps);

    if (row.phase === 'tool-started' && row.toolCallId && row.toolName) {
      const aspect =
        row.toolName === 'generate_image'
          ? imageAspectSchema.safeParse(row.aspectRatio ?? '1:1')
          : undefined;
      const mcp = row.mcp === null ? undefined : mcpToolRefSchema.safeParse(row.mcp);
      steps.set(row.toolCallId, {
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        ...(mcp?.success ? { mcp: mcp.data } : {}),
        status: 'running',
        startedAt: row.at.toISOString(),
        ...display('input', row.input, bound),
        ...(aspect?.success ? { aspectRatio: aspect.data } : {}),
      });
      continue;
    }

    if (row.phase === 'tool-diff') {
      const step = row.toolCallId ? steps.get(row.toolCallId) : undefined;
      // Read back as the contract states it: a row written by another version is dropped,
      // never passed through.
      const diff = codeDiffSchema.safeParse(row.diff);

      if (step && diff.success) {
        step.diff = diff.data;
        if (row.diffLines) linesCut.add(step);
      }
      continue;
    }

    // An approved action runs ahead of the turn's first step and closes itself.
    if (row.phase === 'tool-completed') {
      const step = row.toolCallId ? steps.get(row.toolCallId) : undefined;

      if (step && step.toolName === row.toolName) {
        Object.assign(step, display('output', row.output, bound));
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
        Object.assign(step, display('output', result.output, bound));
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
        ...display('output', row.output, bound),
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
      steps: [...(timelines.get(run.id)?.values() ?? [])].map((step) => ({
        ...step,
        // A tool still "running" in a turn that ended never came back.
        ...(step.status === 'running' && !active.has(run.id) ? { status: 'stopped' as const } : {}),
        // Only a step that lost something to the list is read again when it is opened.
        ...(options.brief && (step.inputTruncated || step.outputTruncated || linesCut.has(step))
          ? { brief: true }
          : {}),
      })),
      ...(run.approval ? { approval: run.approval } : {}),
      ...(run.question ? { question: run.question } : {}),
    }));
}

/**
 * One tool of a conversation in full, by the id its model gave the call: the turn that started
 * it is found among this conversation's turns alone, then read as a timeline reads it.
 */
export async function sessionToolStep(
  db: Queryable,
  profileId: string,
  sessionId: string,
  toolCallId: string,
): Promise<ToolStep | undefined> {
  const [started] = await db
    .select({ runId: checkpoints.runId })
    .from(checkpoints)
    .innerJoin(runs, eq(runs.id, checkpoints.runId))
    .where(
      and(
        eq(runs.profileId, profileId),
        eq(runs.sessionId, sessionId),
        eq(checkpoints.profileId, profileId),
        sql`${checkpoints.data}->>'phase' = 'tool-started'`,
        sql`${checkpoints.data}->>'toolCallId' = ${toolCallId}`,
      ),
    )
    .orderBy(desc(checkpoints.createdAt))
    .limit(1);
  if (!started) return undefined;

  const [timeline] = await sessionTimeline(db, profileId, sessionId, [started.runId]);
  return timeline?.steps.find((step) => step.toolCallId === toolCallId);
}

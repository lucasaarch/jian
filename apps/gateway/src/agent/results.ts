import type { Run } from '@jian/contracts';
import { tokenCounter } from '../context/budget.js';
import { defaultScale } from '../context/scale.js';
import type { RuntimeOptions } from './types.js';

/**
 * Sizes in the provider's tokens, as the result budget is written: the gateway's estimate times
 * the run's scale (`context/scale.ts`), rounded up. Counted as bytes, Claude's 12,000 held about
 * 5,000 of its tokens, and the agent paged with read_artifact what would have fit, each page a
 * step that sends the whole prompt again. With no scale given, the provider's default, which is
 * above anything measured, so a result is only ever cut early, never let in too large.
 */
function resultTokens(run: Run, scale?: number) {
  const model = run.model ?? run.profile.model;
  const estimate = tokenCounter(model.provider, model.modelId);
  const by = scale ?? defaultScale(model.provider);
  return { count: (text: string) => Math.ceil(estimate(text) * by), scale: by };
}

// Replace longer secrets first so an overlapping shorter value cannot leave a suffix exposed.
export function redactText(text: string, secrets: ReadonlySet<string>): string {
  let result = text;

  const variants = [...secrets].flatMap((secret) =>
    secret ? [secret, JSON.stringify(secret).slice(1, -1)] : [],
  );

  for (const variant of [...new Set(variants)].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(variant, '[REDACTED]');
  }

  return result;
}

export function redactOutput(output: unknown, secrets: ReadonlySet<string>): unknown {
  let normalized: unknown;

  try {
    normalized = JSON.parse(JSON.stringify(output) ?? 'null');
  } catch {
    return '[Unserializable tool result]';
  }

  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redactText(value, secrets);
    }

    if (Array.isArray(value)) {
      return value.map(visit);
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redactText(key, secrets), visit(item)]),
      );
    }

    return value;
  };

  return visit(normalized);
}

/** MCP often wraps structured data in a text block; keep one representation for paging. */
function structuredMcpResult(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output;
  const result = output as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (result.content?.length !== 1 || result.content[0]?.type !== 'text') return output;
  try {
    const data: unknown = JSON.parse(result.content[0].text ?? '');
    if (!data || typeof data !== 'object') return output;
    const { content: _, ...rest } = result;
    return { ...rest, data };
  } catch {
    return output;
  }
}

/** Fit the serialized page, including escaped quotes and its cursor, rather than guessing chars. */
export function artifactPage(
  content: string,
  offset: number,
  limit: number,
  run: Run,
  artifactId?: string,
  /** The run's scale; the page must pass `boundToolResult` counted the same way. */
  scale?: number,
) {
  if (offset > content.length) throw new Error('Artifact offset is beyond the end of the result');
  const { count } = resultTokens(run, scale);
  const budget = (run.contextPolicy ?? run.profile.contextPolicy).toolResultTokens;
  const metadata: { artifactId?: string; totalCharacters?: number; instruction?: string } =
    artifactId
      ? {
          artifactId,
          totalCharacters: content.length,
          instruction:
            'Read every page with read_artifact at nextOffset until null before reviewing. Full output is preserved.',
        }
      : {};
  const page = (size: number) => ({
    ...metadata,
    content: content.slice(offset, offset + size),
    nextOffset: offset + size < content.length ? offset + size : null,
  });
  // Tiny result budgets still need a usable cursor, rather than an endlessly empty page.
  if (count(JSON.stringify(page(1))) > budget) delete metadata.instruction;
  if (count(JSON.stringify(page(1))) > budget) delete metadata.totalCharacters;
  let low = 0;
  let high = Math.max(0, Math.min(limit, content.length - offset));
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    if (count(JSON.stringify(page(size))) <= budget) low = size;
    else high = size - 1;
  }
  return page(low);
}

/** A string past this is long text, cut by its ends; a shorter one is kept whole beside it. */
const LONG_TEXT = 512;

/**
 * Room a step's results share, as a number of single results' budgets. One step's parallel
 * calls each fitting their own budget can still fill the context together; past this, the
 * largest are cut first.
 */
export const STEP_RESULTS = 3;

const figure = (value: number) => value.toLocaleString('en');

/** Lines as a reader counts them: a final newline ends the last line, it does not start one. */
const lineCount = (text: string) =>
  text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;

type TextShape = {
  texts: string[];
  /** The result with these in place of its long texts. */
  rebuild: (texts: string[]) => Record<string, unknown>;
};

const isTextBlock = (block: unknown): block is { type: 'text'; text: string } =>
  Boolean(block) &&
  typeof block === 'object' &&
  (block as { type?: unknown }).type === 'text' &&
  typeof (block as { text?: unknown }).text === 'string';

/**
 * Where a result's bulk is text: a string, an object whose long string fields hold most of it
 * (a command's output, a file, search matches, a page), or an MCP result made of text blocks.
 * Its first and last parts are what the agent needs from such a result: what it was, and how it
 * ended, which is where a command's error is. Anything else, a list or a record, stays JSON.
 */
function textShape(value: unknown): TextShape | undefined {
  if (typeof value === 'string') return { texts: [value], rebuild: ([text]) => ({ text }) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const content = data.content;
  if (Array.isArray(content) && content.length && content.every(isTextBlock)) {
    return {
      texts: [content.map((block) => block.text).join('\n')],
      rebuild: ([text]) => ({ ...data, content: [{ type: 'text', text }] }),
    };
  }
  const keys = Object.keys(data).filter(
    (key) => typeof data[key] === 'string' && (data[key] as string).length >= LONG_TEXT,
  );
  if (!keys.length) return undefined;
  const bulk = keys.reduce((sum, key) => sum + (data[key] as string).length, 0);
  const rest = JSON.stringify(
    Object.fromEntries(Object.entries(data).filter(([key]) => !keys.includes(key))),
  );
  if (rest.length > bulk / 4) return undefined;
  return {
    texts: keys.map((key) => data[key] as string),
    rebuild: (texts) => ({
      ...data,
      ...Object.fromEntries(keys.map((key, index) => [key, texts[index]])),
    }),
  };
}

/** Room for each text, in characters: the short ones whole, the rest an equal share. */
function shares(lengths: number[], room: number): number[] {
  const order = lengths
    .map((length, index) => ({ length, index }))
    .sort((a, b) => a.length - b.length);
  const out = lengths.map(() => 0);
  let left = room;
  for (const [position, { length, index }] of order.entries()) {
    const share = Math.max(0, Math.min(length, Math.floor(left / (order.length - position))));
    out[index] = share;
    left -= share;
  }
  return out;
}

/** An index moved off the middle of a surrogate pair, so no half of a character is kept. */
function whole(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && index < text.length && code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

/** A size as a reader takes it in: lines when there are several, characters for one. */
const size = (lines: number, characters: number) =>
  lines > 1
    ? `${figure(lines)} lines (${figure(characters)} characters)`
    : `${figure(characters)} characters`;

/**
 * What a command's own capture left out before the result reached Jian, in the form the
 * gateway's shell (`shell.ts`) and Jian Remote (`ends.ts` in remote-core) write: kept nowhere.
 */
const NOT_KEPT = /\[… ([\d,]+) lines \(([\d,]+) characters\) of this output were not kept\]/g;

function notKept(text: string) {
  let markers = 0;
  let lines = 0;
  let characters = 0;
  /** What the markers themselves take, with the line breaks either side of each. */
  let written = 0;
  for (const found of text.matchAll(NOT_KEPT)) {
    markers++;
    lines += Number((found[1] ?? '0').replaceAll(',', ''));
    characters += Number((found[2] ?? '0').replaceAll(',', ''));
    written += found[0].length + 2;
  }
  return { markers, lines, characters, written };
}

/**
 * The first and last parts of a text, within `room` characters, with a header giving its
 * original size and a marker where the middle was, saying how much is missing and where it is.
 */
export function headTail(text: string, room: number, tokens: number, where: string): string {
  if (text.length <= room) return text;
  // The size the command printed, not what reached Jian: a capture's marker stands for what it
  // dropped. Each is written as `head\n[marker]\n tail`, so it adds its own line and splits the
  // line it was cut in: two lines to take off for each, before adding back the ones it lost.
  const lost = notKept(text);
  const lines = lineCount(text) - 2 * lost.markers + lost.lines;
  const characters = text.length - lost.written + lost.characters;
  const printed = Math.round(tokens * (1 + lost.characters / Math.max(1, text.length)));
  // Part of one line dropped is a size in characters, whatever was kept around it.
  const inLines = lines > 1 && !(lost.markers && !lost.lines);
  const never = !lost.markers
    ? ''
    : lost.lines
      ? ` ${figure(lost.lines)} lines of them were never kept, by the command's own capture.`
      : ` ${figure(lost.characters)} characters of them were never kept, by the command's own capture.`;
  const header = `[${inLines ? `${figure(lines)} lines` : `${figure(characters)} characters`}, about ${figure(printed)} tokens; its first and last parts follow.${never}]\n`;
  // The marker's own length, at most: its figures are at most as long as the text's.
  const keep = Math.max(0, room - header.length - where.length - 60);
  let head = text.slice(0, whole(text, Math.ceil(keep / 2)));
  let tail = keep ? text.slice(whole(text, text.length - Math.floor(keep / 2))) : '';
  // On line boundaries when one is near, so neither part breaks off mid-line.
  const headEnd = head.lastIndexOf('\n');
  if (headEnd >= head.length * 0.8) head = head.slice(0, headEnd + 1);
  const tailStart = tail.indexOf('\n');
  if (tailStart >= 0 && tailStart < tail.length * 0.2) tail = tail.slice(tailStart + 1);
  const middle = text.slice(head.length, text.length - tail.length);
  return `${header}${head}${head.endsWith('\n') || !head ? '' : '\n'}[… ${size(lineCount(middle), middle.length)} left out here. ${where}]\n${tail}`;
}

/** What the agent is told of a result that was cut, and of where the whole of it is. */
function cutNotice(artifactId: string | undefined) {
  return artifactId
    ? `read_artifact with artifactId "${artifactId}" returns everything.`
    : 'The full output could not be saved: do not treat this as the whole result, or repeat a call that changed something.';
}

const UNSAVED = {
  incomplete: true,
  error:
    'The full output could not be saved. This preview is incomplete. Do not treat it as the full result or repeat a mutating call; narrow or paginate a read request instead.',
};

export async function boundToolResult(
  output: unknown,
  toolName: string,
  run: Run,
  secrets: ReadonlySet<string>,
  options: Pick<RuntimeOptions, 'storeArtifact'>,
  /** Provider tokens per token of the estimate, as the run measured it (`context/scale.ts`). */
  scale?: number,
  /**
   * A smaller room than the run's budget, for a step whose results together are past theirs,
   * and the artifact already holding this result, so it is not stored twice.
   */
  within?: { limit: number; artifactId?: string },
): Promise<unknown> {
  const sanitized = redactOutput(
    toolName.startsWith('mcp__') ? structuredMcpResult(output) : output,
    secrets,
  );
  const json = JSON.stringify(sanitized) ?? 'null';
  const { count } = resultTokens(run, scale);
  const limit = within?.limit ?? (run.contextPolicy ?? run.profile.contextPolicy).toolResultTokens;

  if (count(json) <= limit) {
    return sanitized;
  }

  let artifact: { artifactId: string; bytes?: number } | undefined = within?.artifactId
    ? { artifactId: within.artifactId }
    : undefined;

  try {
    artifact ??= await options.storeArtifact?.(run, toolName, sanitized);
  } catch {
    // Tool execution already happened. Keep a bounded preview rather than retrying the effect.
  }

  const marks = {
    truncated: true,
    artifactId: artifact?.artifactId,
    ...(!artifact ? UNSAVED : {}),
  };

  // Characters the budget holds, read from this result's own characters per token: a real
  // tokenizer reads several to a token, byte counting one, and either way the first try is
  // close. Each try below narrows until the whole result, escapes and all, fits.
  const fits = Math.floor(limit * (json.length / Math.max(1, count(json))) * 0.95);

  const shape = textShape(sanitized);
  if (shape) {
    const tokens = shape.texts.map(count);
    const where = cutNotice(artifact?.artifactId);
    // What the rest of the result takes, the cut's marks included, leaves the texts the room.
    let room =
      fits - JSON.stringify({ ...marks, ...shape.rebuild(shape.texts.map(() => where)) }).length;
    // Down to a few dozen characters: even then the last line, where an error is, is worth more
    // than the start of the JSON.
    while (room > 40) {
      const sizes = shares(
        shape.texts.map((text) => text.length),
        room,
      );
      const result = {
        ...marks,
        ...shape.rebuild(
          shape.texts.map((text, index) =>
            headTail(text, sizes[index] ?? 0, tokens[index] ?? 0, where),
          ),
        ),
      };
      if (count(JSON.stringify(result)) <= limit) return result;
      room = Math.floor(room * 0.8);
    }
  }

  if (artifact && toolName.startsWith('mcp__') && !shape && !within) {
    return artifactPage(json, 0, json.length, run, artifact.artifactId, scale);
  }

  let previewSize = Math.min(json.length, fits);
  let result = { ...marks, preview: json.slice(0, previewSize), bytes: Buffer.byteLength(json) };

  while (previewSize > 0 && count(JSON.stringify(result)) > limit) {
    previewSize = Math.floor(previewSize * 0.8);
    result = { ...result, preview: json.slice(0, previewSize) };
  }

  if (count(JSON.stringify(result)) > limit) {
    throw new Error('Tool result budget exceeded');
  }

  return result;
}

/**
 * An MCP result carrying more than text (an image, a resource): what reaches the model is those
 * blocks, which a cut would turn into a JSON preview of their data. It stays out of a step's
 * fitting, as a screenshot does.
 */
export function carriesMedia(output: unknown): boolean {
  const content = (output as { content?: unknown } | null)?.content;
  return Array.isArray(content) && content.some((block) => !isTextBlock(block));
}

/** One call of a step, as it ran and as it was bounded on its own. */
export type StepResult = { toolCallId: string; toolName: string; output: unknown; result: unknown };

/**
 * What a step's results become when together they pass STEP_RESULTS budgets: the smallest stay
 * as they are, and the largest are cut, to an equal share each of the room the others leave.
 * Only those cut are returned. Each keeps the artifact it was stored in, or is stored now, so
 * the whole of it can be read back; one that cannot be stored or fitted stays as it was.
 */
export async function fitStep(
  step: readonly StepResult[],
  run: Run,
  secrets: ReadonlySet<string>,
  options: Pick<RuntimeOptions, 'storeArtifact'>,
  scale?: number,
): Promise<Map<string, unknown>> {
  const { count } = resultTokens(run, scale);
  const budget = (run.contextPolicy ?? run.profile.contextPolicy).toolResultTokens;
  const room = STEP_RESULTS * budget;
  const least = Math.max(400, Math.floor(budget / 10));
  const all = step.map((entry) => ({
    ...entry,
    tokens: count(JSON.stringify(entry.result) ?? 'null'),
  }));
  const fitted = new Map<string, unknown>();
  if (all.reduce((sum, entry) => sum + entry.tokens, 0) <= room) return fitted;

  // A page of read_artifact is already one result's room, asked for at an offset: cut, the
  // agent's next offset would skip what was left out. It takes its room before the rest.
  const pages = all.filter((entry) => entry.toolName === 'read_artifact');
  const sized = all
    .filter((entry) => entry.toolName !== 'read_artifact')
    .sort((a, b) => a.tokens - b.tokens);
  let left = room - pages.reduce((sum, entry) => sum + entry.tokens, 0);
  for (const [position, entry] of sized.entries()) {
    // Never below a tenth of one result's room, and 400 tokens, which a cut's header and marker
    // need with a few lines of each end: pages that took the room would leave the rest nothing
    // to fit into, and a result that cannot be cut is kept whole, far past it.
    const share = Math.max(least, Math.floor(left / (sized.length - position)));
    if (entry.tokens <= share) {
      left -= entry.tokens;
      continue;
    }
    const stored = (entry.result as { artifactId?: unknown } | null)?.artifactId;
    try {
      const cut = await boundToolResult(
        entry.output,
        entry.toolName,
        run,
        secrets,
        options,
        scale,
        {
          limit: share,
          ...(typeof stored === 'string' ? { artifactId: stored } : {}),
        },
      );
      // Cut without a stored copy, the agent would lose what it had whole: it keeps that.
      if ((cut as { incomplete?: boolean }).incomplete) throw new Error('Not stored');
      fitted.set(entry.toolCallId, cut);
      left -= count(JSON.stringify(cut));
    } catch {
      left -= entry.tokens;
    }
  }
  return fitted;
}

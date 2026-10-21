import type { SessionObjective } from '@jian/contracts';
import { MAX_OBJECTIVE_TEXT, sessionObjectiveSchema } from '@jian/contracts';

/** Cap on auto-follow-ups for one open objective before the gateway asks the owner. */
export const MAX_OBJECTIVE_CONTINUATIONS = 25;

/**
 * Even shorter than the stored goal when the continue wake re-states it — never a log dump.
 * Defense for objectives written before sanitization, and for any residual noise.
 */
export const MAX_OBJECTIVE_CONTINUE_SUMMARY = 160;

export type ObjectiveCommand =
  | { action: 'set'; text: string }
  | { action: 'done' }
  | { action: 'cancel' };

/**
 * Standalone owner commands, same shape as `/ponytail` and `/caveman`.
 * `/objective <text>` sets work; `/objective done` and `/done` finish it;
 * `/objective cancel` and `/cancel objective` drop it.
 */
export function parseObjectiveCommand(text: string): ObjectiveCommand | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower === '/objective done' || lower === '/done') return { action: 'done' };
  if (lower === '/objective cancel' || lower === '/cancel objective') return { action: 'cancel' };
  const match = trimmed.match(/^\/objective(?:\s+|:)(.+)$/is);
  if (!match?.[1]) return undefined;
  const body = match[1].trim();
  if (!body || body.toLowerCase() === 'done' || body.toLowerCase() === 'cancel') return undefined;
  return { action: 'set', text: sanitizeObjectiveText(body) };
}

/**
 * Lines that look like shell/login noise or stack frames, not a durable goal.
 * Includes `user@host ~ % …` prompts and piped curl/bash install one-liners.
 */
const DUMP_LINE =
  /^(Last login:|Password:|\$ |% |>>> |\S+@\S+\s+.*[%$#]\s|npm ERR!|pnpm ERR!|yarn error|Error:|TypeError|ERR_[A-Z0-9_]+|Traceback |Caused by:|Exception:|node:internal\/|HTTP\/\d|# |\.?\/[\w./-]+:\d+|at\s+\S+\s*\()/i;

function looksLikeNoiseLine(line: string): boolean {
  if (DUMP_LINE.test(line)) return true;
  if (/ERR_[A-Z0-9_]+/.test(line)) return true;
  if (/^\s*at\s+\S+/.test(line)) return true;
  if (/\bcurl\b/i.test(line) && /\|\s*bash\b/i.test(line)) return true;
  if (/node:internal\//.test(line)) return true;
  return false;
}

/**
 * Terminal dumps, stack traces, and multi-line tool output must not become the durable goal.
 * Auto-continue re-injects this text; a stale error log would re-drive the model into a fixed bug.
 */
export function looksLikeObjectiveDump(text: string): boolean {
  const newlines = (text.match(/\n/g) ?? []).length;
  if (newlines >= 4) return true;
  if (/Last login:/i.test(text)) return true;
  if (/Traceback \(most recent call last\)/i.test(text)) return true;
  if (/node:internal\//.test(text)) return true;
  if (/ERR_[A-Z0-9_]+/.test(text) && text.length > 120) return true;
  if (/\bError\b/.test(text) && /^\s*at\s+\S+/m.test(text)) return true;
  if ((text.match(/^\$ /gm) ?? []).length >= 2) return true;
  if (/\bcurl\b/i.test(text) && /\|\s*bash\b/i.test(text) && newlines >= 1) return true;
  return false;
}

function truncateGoal(text: string, max: number): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const lastSpace = sliced.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? sliced.slice(0, lastSpace) : sliced;
  return cut.trimEnd();
}

/**
 * Collapse an objective candidate to a short single-line durable goal.
 * Rejects dump-shaped payloads by preferring a goal-like line, else a neutral fallback.
 */
export function sanitizeObjectiveText(raw: string, max = MAX_OBJECTIVE_TEXT): string {
  const trimmed = raw.trim().replace(/\r\n/g, '\n');
  if (!trimmed) return trimmed;

  let candidate = trimmed;
  if (looksLikeObjectiveDump(trimmed)) {
    const lines = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const goalLine = lines.find(
      (line) => !looksLikeNoiseLine(line) && line.length >= 12 && !looksLikeObjectiveDump(line),
    );
    // Prefer a real goal line over the first dump line ("Last login:…") — never store the dump.
    candidate = goalLine ?? 'Continue prior open work';
  }

  const collapsed = candidate.replace(/\s+/g, ' ').trim();
  return truncateGoal(collapsed, max);
}

/** Summary used inside auto-continue wakes and prompt injection — never raw shell output. */
export function objectiveContinueSummary(text: string): string {
  return sanitizeObjectiveText(text, MAX_OBJECTIVE_CONTINUE_SUMMARY);
}

/** Stable wake text for the next principal slice while an objective stays open. */
export function objectiveContinuePrompt(text: string): string {
  return [
    'Continue the open session objective. Do not wait for the owner to say continue.',
    `Goal: ${objectiveContinueSummary(text)}`,
    'Take the next concrete steps with tools.',
    'Call complete_session_objective when the objective is fully satisfied,',
    'or block_session_objective when you need the owner’s input.',
    'Progress lines are commentary, not a reason to stop.',
  ].join(' ');
}

export function objectiveAt(
  text: string,
  status: SessionObjective['status'],
  at: string,
  extras: { continuations?: number; note?: string } = {},
): SessionObjective {
  return sessionObjectiveSchema.parse({
    text: sanitizeObjectiveText(text),
    status,
    updatedAt: at,
    continuations: extras.continuations ?? 0,
    ...(extras.note ? { note: extras.note } : {}),
  });
}

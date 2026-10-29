import type { CodeDiff } from '@jian/contracts';
import { structuredPatch } from 'diff';

/**
 * What one write changed in a file, line by line, for the owner to read in the conversation:
 * the hunks a `git diff` would show, each line numbered on the old side, the new side or both.
 *
 * It is for reading, never for applying: it is cut at a size a person reads, and the agent never
 * sees it, so its size costs no context.
 */

/** Lines of unchanged text around each change, as git shows by default. */
const CONTEXT = 3;
/** Diff lines kept for one write; past this the diff says it was cut. */
export const MAX_DIFF_LINES = 400;
/** A line longer than this is shown cut: a minified bundle would be one enormous row. */
const LINE_CHARS = 500;
/** Bytes of text kept across all lines of one diff. */
const MAX_DIFF_BYTES = 200_000;
/** A file larger than this is not diffed at all: the comparison would cost more than it shows. */
const MAX_COMPARED_BYTES = 1_000_000;

const languages: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
};

const languageOf = (path: string) => languages[path.split('.').pop()?.toLowerCase() ?? ''];

/**
 * The line a hunk sits under, the way git's default finds it: the nearest line above it that
 * starts in the first column with a letter, `_` or `$` — a function, a class, a section.
 */
function headerOf(lines: string[], before: number): string | undefined {
  for (let index = before - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';

    if (/^[A-Za-z_$]/.test(line)) return line.trimEnd().slice(0, 120);
  }

  return undefined;
}

/**
 * The change from `before` to `after` in the file at `path`. `before` is undefined for a file
 * that did not exist. Line endings are compared as lines, so a Windows file diffs as it reads.
 */
export function fileDiff(
  path: string,
  before: string | undefined,
  after: string,
): CodeDiff | undefined {
  const old = (before ?? '').replace(/\r\n/g, '\n');
  const next = after.replace(/\r\n/g, '\n');

  if (old === next) return undefined;
  if (Buffer.byteLength(old) + Buffer.byteLength(next) > MAX_COMPARED_BYTES) return undefined;

  const patch = structuredPatch(path, path, old, next, '', '', { context: CONTEXT });
  const oldLines = old.split('\n');
  let additions = 0;
  let deletions = 0;
  let kept = 0;
  let bytes = 0;
  let truncated = false;
  const hunks: CodeDiff['hunks'] = [];

  for (const hunk of patch.hunks) {
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    const lines: CodeDiff['hunks'][number]['lines'] = [];

    for (const raw of hunk.lines) {
      const mark = raw[0];
      // "\ No newline at end of file" says nothing a reader of the lines needs.
      if (mark !== ' ' && mark !== '+' && mark !== '-') continue;
      if (mark === '+') additions += 1;
      if (mark === '-') deletions += 1;

      const full = raw.slice(1);
      const text = full.length > LINE_CHARS ? `${full.slice(0, LINE_CHARS)} …` : full;
      const fits = kept < MAX_DIFF_LINES && bytes + text.length <= MAX_DIFF_BYTES;

      if (fits) {
        lines.push(
          mark === '+'
            ? { kind: 'add', new: newNo, text }
            : mark === '-'
              ? { kind: 'del', old: oldNo, text }
              : { kind: 'context', old: oldNo, new: newNo, text },
        );
        kept += 1;
        bytes += text.length;
      } else {
        truncated = true;
      }

      if (mark !== '+') oldNo += 1;
      if (mark !== '-') newNo += 1;
    }

    if (lines.length) {
      const header = before === undefined ? undefined : headerOf(oldLines, hunk.oldStart - 1);

      hunks.push({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        ...(header ? { header } : {}),
        lines,
      });
    }
  }

  const language = languageOf(path);

  return {
    path,
    ...(language ? { language } : {}),
    additions,
    deletions,
    ...(before === undefined ? { created: true } : {}),
    hunks,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** The tools whose result carries a diff. Anything else named `diff` is the tool's own data. */
const WRITERS = new Set(['edit_file', 'write_file']);

/** A file write's result without its diff, and the diff on its own. */
export function splitDiff(toolName: string, output: unknown): { output: unknown; diff?: CodeDiff } {
  if (!WRITERS.has(toolName) || !output || typeof output !== 'object' || !('diff' in output)) {
    return { output };
  }

  const { diff, ...rest } = output as { diff?: CodeDiff };

  return { output: rest, ...(diff ? { diff } : {}) };
}

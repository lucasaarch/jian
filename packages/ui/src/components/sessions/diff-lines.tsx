'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CodeDiff } from '../../lib/api';
import { GatewayAnswer } from '../../lib/api/result';
import { highlightLines, type Segment } from '../ui/highlight';

type Hunk = CodeDiff['hunks'][number];
type Line = Hunk['lines'][number];

/** Hidden lines one press of an arrow brings in. */
const STEP = 20;
/** Lines of context git and GitHub leave after a change: fewer means the file ended there. */
const CONTEXT = 3;

/** One row of a diff, with one number: where the line is now, or where it was if it is gone. */
export function DiffLine({
  line,
  segments,
}: {
  line: Pick<Line, 'kind' | 'old' | 'new'>;
  segments: Segment[];
}) {
  return (
    <div className="code-diff-line" data-kind={line.kind}>
      <span className="code-diff-number">{line.new ?? line.old}</span>
      <code>
        {segments.map((segment, at) =>
          segment.className ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments of a line never reorder.
            <span key={at} className={segment.className}>
              {segment.text}
            </span>
          ) : (
            segment.text
          ),
        )}
      </code>
    </div>
  );
}

/** Where two lines part: the characters around the middle that they share are left alone. */
function middleOf(line: string, other: string): [number, number] {
  const most = Math.min(line.length, other.length);
  let start = 0;
  while (start < most && line[start] === other[start]) start += 1;
  let end = 0;
  while (end < most - start && line.at(-1 - end) === other.at(-1 - end)) end += 1;
  return [start, line.length - end];
}

/** The coloured pieces of a line with `[from, to)` marked, cut wherever the range cuts them. */
function marked(segments: Segment[], [from, to]: [number, number]): Segment[] {
  if (from >= to) return segments;
  const pieces: Segment[] = [];
  let at = 0;
  for (const segment of segments) {
    const start = at;
    const end = at + segment.text.length;
    at = end;
    const cuts = [
      start,
      Math.max(start, Math.min(from, end)),
      Math.min(end, Math.max(to, start)),
      end,
    ];
    for (let index = 0; index < 3; index += 1) {
      const [left = 0, right = 0] = [cuts[index], cuts[index + 1]];
      if (left === right) continue;
      const className = [segment.className, index === 1 && 'code-diff-changed']
        .filter(Boolean)
        .join(' ');
      pieces.push({
        text: segment.text.slice(left - start, right - start),
        ...(className ? { className } : {}),
      });
    }
  }
  return pieces;
}

/**
 * Marks what changed inside a line replaced by another. A run of removed lines followed by a run
 * of added ones is paired in order, as a reader compares them; a line with no partner was only
 * added or only removed, and its band already says all of it.
 */
export function markChanges(lines: Line[], segments: Segment[][]): Segment[][] {
  const result = [...segments];
  let index = 0;
  while (index < lines.length) {
    const dels = index;
    while (lines[index]?.kind === 'del') index += 1;
    const adds = index;
    while (lines[index]?.kind === 'add') index += 1;
    const pairs = Math.min(adds - dels, index - adds);
    for (let pair = 0; pair < pairs; pair += 1) {
      const gone = dels + pair;
      const fresh = adds + pair;
      const before = lines[gone]?.text ?? '';
      const after = lines[fresh]?.text ?? '';
      result[gone] = marked(result[gone] ?? [], middleOf(before, after));
      result[fresh] = marked(result[fresh] ?? [], middleOf(after, before));
    }
    if (index === dels) index += 1;
  }
  return result;
}

/** A hunk with no lines on the new side names the line it comes after, as git writes it. */
const startOf = (hunk: Hunk) => (hunk.newLines ? hunk.newStart : hunk.newStart + 1);
const endOf = (hunk: Hunk) => startOf(hunk) + hunk.newLines;

/** The diff and the file disagree once either moved on: its lines would sit under wrong numbers. */
function agrees(hunks: Hunk[], file: string[]): boolean {
  return hunks.every((hunk) =>
    hunk.lines.every((line) => line.new === undefined || file[line.new - 1] === line.text),
  );
}

function reachesEnd(hunk: Hunk): boolean {
  let context = 0;
  for (const line of hunk.lines.toReversed()) {
    if (line.kind !== 'context') break;
    context += 1;
  }
  return context < CONTEXT;
}

type Reading = {
  hunks: Hunk[];
  /** How many lines were asked for at each gap, from the change above and the one below. */
  shown: Record<number, { down: number; up: number }>;
  file?: string[];
  reading?: boolean;
  failedAt?: number;
  /** Why, when the gateway said; a file that moved on or a lost connection get the plain words. */
  failure?: string;
};

/**
 * The lines a diff leaves out, by gap: gap `n` lies before hunk `n`, and the last one after every
 * hunk. They are read once, on the first press, and all of them are unchanged, so the file as it
 * is now has them. A new diff starts over: what was read may no longer be the file it speaks of.
 * Without `readLines`, or on a diff that was cut and so may hide changes, nothing can be brought in.
 */
export function useUnmodified(diff: CodeDiff, readLines?: () => Promise<string[]>) {
  const { hunks } = diff;
  const reader = diff.truncated ? undefined : readLines;
  const [held, setHeld] = useState<Reading>({ hunks, shown: {} });
  let reading = held;
  if (held.hunks !== hunks) {
    reading = { hunks, shown: {} };
    setHeld(reading);
  }
  const { file } = reading;
  const painted = useMemo(
    () => (file ? highlightLines(file.join('\n'), diff.language) : undefined),
    [file, diff.language],
  );

  const reveal = (gap: number, side: 'down' | 'up') => {
    if (!reader) return;
    setHeld((now) => {
      const shown = now.shown[gap] ?? { down: 0, up: 0 };
      return {
        ...now,
        failedAt: undefined,
        failure: undefined,
        reading: !now.file,
        shown: { ...now.shown, [gap]: { ...shown, [side]: shown[side] + STEP } },
      };
    });
    if (file || reading.reading) return;
    const failed = (now: Reading, failure?: string): Reading => ({
      ...now,
      reading: false,
      failedAt: gap,
      failure,
      shown: {},
    });
    reader().then(
      (lines) =>
        setHeld((now) => {
          if (now.hunks !== hunks) return now;
          return agrees(hunks, lines) ? { ...now, file: lines, reading: false } : failed(now);
        }),
      (error: unknown) =>
        setHeld((now) => {
          if (now.hunks !== hunks) return now;
          return failed(now, error instanceof GatewayAnswer ? error.message : undefined);
        }),
    );
  };

  /** What gap `index` holds now, or undefined when it holds nothing. */
  const gapAt = (index: number) => {
    const above = hunks[index - 1];
    const below = hunks[index];
    const edge = !above || !below;
    if (!below && (!reader || diff.created || (above && reachesEnd(above)))) return undefined;
    const from = above ? endOf(above) : 1;
    const to = below ? startOf(below) : file && file.length + 1;
    const total = to === undefined ? undefined : to - from;
    const shown = reading.shown[index] ?? { down: 0, up: 0 };
    if (total === 0 || (total !== undefined && total < 0)) return undefined;
    const known = file ? (total ?? 0) : 0;
    const down = Math.min(shown.down, known);
    const up = Math.min(shown.up, known - down);
    const left = total === undefined ? undefined : total - (file ? down + up : 0);

    return {
      failure:
        reading.failedAt === index
          ? (reading.failure ?? 'Could not read these lines. Try again.')
          : undefined,
      busy: Boolean(reading.reading),
      label: diff.truncated
        ? 'More lines'
        : edge
          ? 'More unmodified lines'
          : `${left} unmodified ${left === 1 ? 'line' : 'lines'}`,
      left,
      canGoDown: Boolean(reader && above),
      canGoUp: Boolean(reader && below),
      top: rangeOf(from, from + down),
      bottom: rangeOf((to ?? 0) - up, to ?? 0),
    };
  };

  const rowOf = (number: number) => (
    <DiffLine
      key={number}
      line={{ kind: 'context', new: number }}
      segments={painted?.[number - 1] ?? []}
    />
  );

  return { gapAt, reveal, rowOf };
}

const rangeOf = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from) }, (_, at) => from + at);

/** A gap in a diff, or as much of it as was read, around the bar that says what is still hidden. */
export function DiffGap({
  index,
  unmodified,
}: {
  index: number;
  unmodified: ReturnType<typeof useUnmodified>;
}) {
  const gap = unmodified.gapAt(index);
  if (!gap) return null;

  return (
    <>
      {gap.top.map(unmodified.rowOf)}
      {gap.left !== 0 && (
        <div className="code-diff-gap" aria-busy={gap.busy}>
          {(gap.canGoDown || gap.canGoUp) && (
            <div className="code-diff-gap-arrows">
              {gap.canGoDown && (
                <button
                  type="button"
                  aria-label="Show more lines below this change"
                  title="Show more lines below this change"
                  onClick={() => unmodified.reveal(index, 'down')}
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              )}
              {gap.canGoUp && (
                <button
                  type="button"
                  aria-label="Show more lines above this change"
                  title="Show more lines above this change"
                  onClick={() => unmodified.reveal(index, 'up')}
                >
                  <ChevronUp size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          <span className="code-diff-gap-label" role={gap.failure ? 'alert' : undefined}>
            {gap.failure ?? gap.label}
          </span>
        </div>
      )}
      {gap.bottom.map(unmodified.rowOf)}
    </>
  );
}

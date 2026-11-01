'use client';

import { ChevronDown, FileCode2 } from 'lucide-react';
import { Fragment, useId, useMemo, useState } from 'react';
import { CheckBox, Fold, Skeleton, SkeletonLine, SkeletonRegion } from '../../kit';
import type { CodeDiff, ToolStep } from '../../lib/api';
import { useFileReview } from '../../lib/stores/reviewed';
import { highlightLines, type Segment } from '../ui/highlight';
import { DiffGap, DiffLine, markChanges, useUnmodified } from './diff-lines';
import { useFoldAll } from './fold-all';

type Line = CodeDiff['hunks'][number]['lines'][number];

/**
 * A hunk's lines with their colours. Each side is highlighted whole — the new side from its
 * context and added lines, the old side from its context and removed ones — and dealt back out
 * line by line, so a token that spans lines keeps its colour across them.
 */
function coloured(lines: Line[], language?: string): Segment[][] {
  const after = lines.filter((line) => line.kind !== 'del');
  const before = lines.filter((line) => line.kind !== 'add');
  const newSide = highlightLines(after.map((line) => line.text).join('\n'), language);
  const oldSide = highlightLines(before.map((line) => line.text).join('\n'), language);
  let fresh = 0;
  let stale = 0;

  return lines.map((line) => {
    if (line.kind === 'del') return oldSide[stale++] ?? [{ text: line.text }];
    if (line.kind === 'context') stale += 1;
    return newSide[fresh++] ?? [{ text: line.text }];
  });
}

function Counts({ diff }: { diff: Pick<CodeDiff, 'additions' | 'deletions'> }) {
  return (
    <span className="code-change-counts">
      <span className="added">+{diff.additions}</span>
      <span className="removed">−{diff.deletions}</span>
    </span>
  );
}

/** What kind of file it is, by its extension, as a tag beside its name: GO, TS, YAML. */
function languageTag(path: string): string | undefined {
  const name = path.split('/').at(-1) ?? '';
  const extension = name.includes('.') ? name.split('.').at(-1) : undefined;
  return extension && extension.length <= 4 ? extension.toUpperCase() : undefined;
}

/** A path that may not fit: the folders give way, never the file's name; all of it is on hover. */
export function FilePath({ path }: { path: string }) {
  return (
    <span className="code-diff-path" title={path}>
      {path.includes('/') && (
        <span className="code-diff-dir">{path.slice(0, path.lastIndexOf('/') + 1)}</span>
      )}
      <span className="code-diff-file">{path.split('/').at(-1)}</span>
    </span>
  );
}

/**
 * One file's change, as a review tool shows it, with one column of line numbers: where a line is
 * now, or where it was for a line that is gone, so the numbers can step back at a removal. `flat`
 * lays it into the panel it is in, edge to edge, with no card around it. `reviewScope` offers to
 * mark it as reviewed, which folds it away: a place, as a pull request, to remember that in.
 * `readLines` reads the file as it is now, to bring in the lines the diff leaves out.
 */
export function FileDiff({
  diff,
  open: initiallyOpen,
  flat = false,
  reviewScope,
  readLines,
}: {
  diff: CodeDiff;
  open: boolean;
  flat?: boolean;
  reviewScope?: string;
  readLines?: () => Promise<string[]>;
}) {
  const review = useFileReview(reviewScope, diff);
  const [open, setOpen] = useState(initiallyOpen && !review.reviewed);
  // Its code is drawn the first time it opens, then stays so the fold has something to move: a
  // pull request of many files draws none of the ones never opened.
  const [drawn, setDrawn] = useState(open);
  if (open && !drawn) setDrawn(true);
  const body = useId();
  useFoldAll(setOpen);
  const unmodified = useUnmodified(diff, readLines);
  const painted = useMemo(
    () =>
      drawn
        ? diff.hunks.map((hunk) => markChanges(hunk.lines, coloured(hunk.lines, diff.language)))
        : [],
    [drawn, diff.hunks, diff.language],
  );
  const kind = languageTag(diff.path);

  return (
    <div className="code-diff" data-flat={flat || undefined}>
      <div className="code-diff-row">
        <button
          type="button"
          className="code-diff-head"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown size={14} className="code-diff-chevron" aria-hidden="true" />
          {flat ? (
            kind && <span className="code-diff-kind">{kind}</span>
          ) : (
            <FileCode2 size={14} aria-hidden="true" />
          )}
          <FilePath path={diff.path} />
          <Counts diff={diff} />
        </button>
        {reviewScope && (
          <CheckBox
            checked={review.reviewed}
            label={`Mark ${diff.path} as reviewed`}
            onCheckedChange={(reviewed) => {
              review.set(reviewed);
              if (reviewed) setOpen(false);
            }}
          />
        )}
      </div>
      <Fold open={open} id={body}>
        {drawn && (
          <div className="code-diff-body">
            <div className="code-diff-lines">
              {diff.hunks.map((hunk, at) => (
                <Fragment key={`${hunk.oldStart}:${hunk.newStart}`}>
                  <DiffGap index={at} unmodified={unmodified} />
                  {hunk.lines.map((line, index) => (
                    <DiffLine
                      // biome-ignore lint/suspicious/noArrayIndexKey: a hunk's lines never reorder.
                      key={index}
                      line={line}
                      segments={painted[at]?.[index] ?? []}
                    />
                  ))}
                </Fragment>
              ))}
              <DiffGap index={diff.hunks.length} unmodified={unmodified} />
            </div>
            {diff.truncated && (
              <p className="code-diff-cut">The rest of this change is too long to show here.</p>
            )}
          </div>
        )}
      </Fold>
    </div>
  );
}

/** The lines a change is outlined with: how long each runs, and what happened to it. */
const OUTLINE: { width: string; kind: CodeDiff['hunks'][number]['lines'][number]['kind'] }[] = [
  { width: 'w-1/4', kind: 'context' },
  { width: 'w-1/3', kind: 'context' },
  { width: 'w-3/5', kind: 'context' },
  { width: 'w-1/2', kind: 'del' },
  { width: 'w-2/5', kind: 'del' },
  { width: 'w-1/2', kind: 'add' },
  { width: 'w-3/5', kind: 'add' },
  { width: 'w-4/5', kind: 'context' },
  { width: 'w-1/4', kind: 'context' },
  { width: 'w-3/5', kind: 'context' },
];

/**
 * A file's change still on its way, laid into the panel as the change will be, reaching past the
 * body's inset the same way, so nothing moves when the code lands.
 */
export function DiffSkeleton() {
  return (
    <SkeletonRegion label="Loading diff…">
      <div className="-mx-(--inspector-inset)">
        <div className="code-diff" data-flat>
          <div className="code-diff-row">
            <div className="code-diff-head">
              <Skeleton className="size-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <SkeletonLine className="w-3/5" />
              </div>
              <Skeleton className="h-3 w-10 shrink-0" />
            </div>
            <Skeleton className="size-4 shrink-0 rounded-[0.3rem]" />
          </div>
          <div className="code-diff-body">
            <div className="font-mono text-[12.5px] leading-[1.65]">
              <div className="code-diff-gap">
                <span className="code-diff-gap-label">
                  <SkeletonLine className="w-1/3" />
                </span>
              </div>
              {OUTLINE.map(({ width, kind }, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed outline never reorders.
                  key={index}
                  className="code-diff-line"
                  data-kind={kind}
                >
                  <span className="code-diff-number">
                    <SkeletonLine className="ml-auto w-5" />
                  </span>
                  <SkeletonLine className={width} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}

function summaryOf(step: ToolStep & { diff: CodeDiff }) {
  if (step.toolName === 'write_file')
    return step.diff.created ? 'Created a file' : 'Rewrote a file';
  const edits = step.diff.hunks.length;

  return `Applied ${edits} ${edits === 1 ? 'edit' : 'edits'}`;
}

/**
 * What a turn's file writes changed, below its Thought Line: one block per write, as the tool
 * reported it. Only writes that went through have a diff; a failed or refused one stays a line
 * in the trace. Every change stays folded until the reader opens it.
 */
export function CodeChanges({ steps }: { steps: ToolStep[] }) {
  const changes = steps.filter(
    (step): step is ToolStep & { diff: CodeDiff } => step.status === 'done' && Boolean(step.diff),
  );

  if (!changes.length) return null;

  return (
    <div className="code-changes">
      {changes.map((step) => {
        return (
          <section key={step.toolCallId} className="code-change" aria-label={summaryOf(step)}>
            <FileDiff diff={step.diff} open={false} />
          </section>
        );
      })}
    </div>
  );
}

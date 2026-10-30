'use client';

import { ChevronDown } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import type { CodeDiff, ToolStep } from '../../lib/api';
import { highlightLines, type Segment } from '../ui/highlight';
import { useFoldAll } from './fold-all';

/** A diff shorter than this opens by itself even in an older turn: it costs a glance. */
const SHORT = 40;

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

const sign = { add: '+', del: '-', context: '' } as const;

/** One file's change, as a review tool shows it: line numbers on both sides and a gutter. */
export function FileDiff({ diff, open: initiallyOpen }: { diff: CodeDiff; open: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const body = useId();
  useFoldAll(setOpen);

  return (
    <div className="code-diff">
      <button
        type="button"
        className="code-diff-head"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={14} className="code-diff-chevron" aria-hidden="true" />
        <span className="code-diff-path">{diff.path}</span>
        <Counts diff={diff} />
      </button>
      {open && (
        <div className="code-diff-body" id={body}>
          <div className="code-diff-lines">
            {diff.hunks.map((hunk) => {
              const segments = coloured(hunk.lines, diff.language);

              return (
                <Fragment key={`${hunk.oldStart}:${hunk.newStart}`}>
                  <div className="code-diff-hunk">
                    @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                    {hunk.header ? ` ${hunk.header}` : ''}
                  </div>
                  {hunk.lines.map((line, index) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: a hunk's lines never reorder.
                      key={index}
                      className="code-diff-line"
                      data-kind={line.kind}
                    >
                      <span className="code-diff-number">{line.old ?? ''}</span>
                      <span className="code-diff-number">{line.new ?? ''}</span>
                      <span className="code-diff-sign" aria-hidden="true">
                        {sign[line.kind]}
                      </span>
                      <code>
                        {(segments[index] ?? []).map((segment, at) =>
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
                  ))}
                </Fragment>
              );
            })}
          </div>
          {diff.truncated && (
            <p className="code-diff-cut">The rest of this change is too long to show here.</p>
          )}
        </div>
      )}
    </div>
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
 * in the trace. `fresh` opens every file, as for the turn being read now; otherwise only short
 * ones open by themselves.
 */
export function CodeChanges({ steps, fresh = false }: { steps: ToolStep[]; fresh?: boolean }) {
  const changes = steps.filter(
    (step): step is ToolStep & { diff: CodeDiff } => step.status === 'done' && Boolean(step.diff),
  );

  if (!changes.length) return null;

  return (
    <div className="code-changes">
      {changes.map((step) => {
        const lines = step.diff.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);

        return (
          <section key={step.toolCallId} className="code-change" aria-label={summaryOf(step)}>
            {/* The counts are the file's, on its own header below: once is enough. */}
            <p className="code-change-row">
              <span className="code-change-summary">{summaryOf(step)}</span>
            </p>
            <FileDiff diff={step.diff} open={fresh || lines <= SHORT} />
          </section>
        );
      })}
    </div>
  );
}

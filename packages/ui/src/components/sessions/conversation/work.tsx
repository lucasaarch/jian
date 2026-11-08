'use client';

import type { CodeDiff, ToolStep } from '../../../lib/api';
import { FilePath } from '../code-change';
import { ThoughtLine } from '../thought-line';
import { traceOf } from '../trace';

/** When a stretch of tools ended: its last tool's end, so a settled line stops its clock there. */
const endOf = (steps: ToolStep[]) =>
  steps
    .map((step) => step.finishedAt ?? step.startedAt)
    .sort()
    .at(-1);

/** Tools a turn used between two things it said, settled. */
export function Worked({
  steps,
  runId,
  startedAt,
  finishedAt = endOf(steps),
}: {
  steps: ToolStep[];
  /** The turn that used them, by which an opened tool reads its whole step. */
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
}) {
  return (
    <ThoughtLine
      working={false}
      steps={traceOf(steps, runId)}
      startedAt={startedAt}
      finishedAt={finishedAt}
    />
  );
}

type Changed = ToolStep & { diff: CodeDiff };

/** The files a settled turn changed, each opening its diff beside the conversation. */
export function RunChangesSummary({
  steps,
  onOpen,
}: {
  steps: ToolStep[];
  onOpen: (step: Changed, opener: HTMLButtonElement) => void;
}) {
  const files = new Map<string, Changed>();
  for (const step of steps) {
    if (step.status === 'done' && step.diff) files.set(step.diff.path, step as Changed);
  }
  if (!files.size) return null;

  return (
    <div className="chat-line theirs">
      <section className="run-change-summary" aria-label="Files changed in this run">
        <p className="run-change-summary-title">Files changed</p>
        <ul>
          {[...files.values()].map((step) => (
            <li key={`${step.toolCallId}:${step.diff.path}`}>
              <button
                type="button"
                aria-label={`${step.diff.path}, ${step.diff.additions} added, ${step.diff.deletions} removed`}
                onClick={(event) => onOpen(step, event.currentTarget)}
              >
                <span className="run-change-summary-path">
                  <FilePath path={step.diff.path} />
                </span>
                <span className="run-change-summary-counts" aria-hidden="true">
                  <i>+{step.diff.additions}</i> <b>−{step.diff.deletions}</b>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

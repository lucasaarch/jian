'use client';

import { Check, ChevronDown, ListChecks, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { OrbState } from 'thinking-orbs';
import { Overlay } from '../../kit/overlay';
import { CodeBlock } from '../ui/code-block';
import { Markdown } from '../ui/markdown';

/** One line of the trace. A step that went wrong stays in it, marked, with what went wrong. */
export type ThoughtStep = {
  key: string;
  text: string;
  status: 'running' | 'done' | 'failed';
  /** How it ended badly, in a word or two beside it. */
  note?: string;
  /** What went wrong, in full, as the tool or the server said it. */
  detail?: string;
};

function FailureDetail({ detail }: { detail: string }) {
  try {
    const result: unknown = JSON.parse(detail);
    const message =
      result && typeof result === 'object' && 'message' in result ? result.message : undefined;
    return (
      <>
        {typeof message === 'string' && (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message}</p>
        )}
        <CodeBlock text={JSON.stringify(result, null, 2)} language="json" />
      </>
    );
  } catch {
    return /^```/m.test(detail) ? (
      <div className="markdown min-w-0 break-words">
        <Markdown text={detail} breaks />
      </div>
    ) : (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {detail}
      </pre>
    );
  }
}

/** Whole seconds keep the activity clock quiet while the conversation is moving. */
const lasted = (seconds: number) =>
  seconds < 60
    ? `${Math.floor(seconds)}s`
    : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;

const spoken = (seconds: number) =>
  seconds < 60
    ? `${Math.round(seconds)} seconds`
    : `${Math.floor(seconds / 60)} minutes ${Math.floor(seconds % 60)} seconds`;

const at = (moment?: string | number) =>
  moment === undefined ? undefined : typeof moment === 'number' ? moment : Date.parse(moment);

/**
 * Activity and outcome share one fixed gutter, so settling never moves the label.
 */
export function WorkMark({
  working,
  failed = false,
  orb = 'composing',
}: {
  working: boolean;
  failed?: boolean;
  orb?: OrbState;
}) {
  if (working)
    return (
      <span className="work-mark" data-working data-activity={orb} aria-hidden="true">
        <span className="work-spinner" />
      </span>
    );

  return (
    <span className="work-mark" data-failed={failed || undefined} aria-hidden="true">
      {failed ? <X size={14} strokeWidth={2.6} /> : <Check size={14} strokeWidth={2.6} />}
    </span>
  );
}

/**
 * What the agent is doing, as one line that breathes while it works and settles into how long
 * it took. The steps it went through fold beneath it, open while it works
 * and folded once it is done, a click away.
 *
 * The time comes from the run's own timestamps, not from when this line was drawn, so a reload
 * or an old turn shows how long the work took instead of starting again from zero.
 */
export function ThoughtLine({
  working,
  label = 'Thinking…',
  doneLabel,
  orb = 'composing',
  steps = [],
  startedAt,
  finishedAt,
  failed = false,
}: {
  working: boolean;
  /** It ended without finishing: the settled mark is a cross, not a check. */
  failed?: boolean;
  label?: string;
  doneLabel?: string;
  orb?: OrbState;
  steps?: ThoughtStep[];
  startedAt?: string | number;
  /** When the work ended; a settled line without it ends at its last known moment. */
  finishedAt?: string | number;
}) {
  const [open, setOpen] = useState(working);
  const [failure, setFailure] = useState<ThoughtStep>();
  const timer = useRef<HTMLSpanElement>(null);
  const trace = useId();
  const start = at(startedAt);
  const end = at(finishedAt);
  const seconds = (now: number) => (start === undefined ? 0 : Math.max(0, (now - start) / 1000));

  // Open while it works, folded once it settles; the reader can still open it by hand.
  useEffect(() => {
    setOpen(working);
  }, [working]);

  // The clock updates its own element without redrawing the streamed answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seconds reads only `start`.
  useEffect(() => {
    if (!working || start === undefined) return;
    const paint = () => {
      if (timer.current) timer.current.textContent = lasted(seconds(Date.now()));
    };
    paint();
    const id = setInterval(paint, 1000);

    return () => clearInterval(id);
  }, [working, start]);

  const settled = start !== undefined ? seconds(end ?? Date.now()) : undefined;
  const foldable = steps.length > 0;
  const summary =
    doneLabel ??
    (steps.length ? `${steps.length} tool ${steps.length === 1 ? 'call' : 'calls'}` : 'Activity');
  const current = working ? label : summary;

  return (
    <div className="thought-line" data-working={working || undefined} data-open={open || undefined}>
      <button
        type="button"
        className="thought-head"
        aria-expanded={foldable ? open : undefined}
        aria-controls={foldable ? trace : undefined}
        disabled={!foldable}
        onClick={() => setOpen((value) => !value)}
      >
        {!working && foldable && !failed ? (
          <span className="work-mark" aria-hidden="true">
            <ListChecks size={14} />
          </span>
        ) : (
          <WorkMark working={working} failed={failed} orb={orb} />
        )}
        <span key={current} className="thought-label" aria-hidden="true">
          {current}
        </span>
        {start !== undefined && (
          <span ref={timer} className="thought-timer" aria-hidden="true">
            {lasted(working ? seconds(Date.now()) : (settled ?? 0))}
          </span>
        )}
        {foldable && <ChevronDown size={14} className="thought-chevron" aria-hidden="true" />}
        <span className="sr-only" role="status">
          {working || settled === undefined ? current : `${summary} · ${spoken(settled)}`}
        </span>
      </button>
      {foldable && (
        <div className="thought-trace" id={trace} inert={!open}>
          <ol>
            {steps.map((step) => (
              <li key={step.key} data-status={step.status}>
                <span className="thought-mark" aria-hidden="true">
                  {step.status === 'running' ? (
                    <i className="thought-pulse" />
                  ) : step.status === 'failed' ? (
                    <X size={12} strokeWidth={2.6} />
                  ) : (
                    <Check size={12} strokeWidth={2.6} />
                  )}
                </span>
                <span className="thought-step">{step.text}</span>
                {step.note &&
                  (step.detail ? (
                    <button
                      type="button"
                      className="thought-note"
                      data-detail
                      aria-haspopup="dialog"
                      aria-label={`${step.note}: ${step.text}`}
                      onClick={() => setFailure(step)}
                    >
                      {step.note}
                    </button>
                  ) : (
                    <span className="thought-note">{step.note}</span>
                  ))}
              </li>
            ))}
          </ol>
        </div>
      )}
      <Overlay
        open={Boolean(failure)}
        onOpenChange={(open) => {
          if (!open) setFailure(undefined);
        }}
        title={failure?.note ?? 'Tool error'}
        size="page"
      >
        {failure?.detail && (
          <div className="grid min-w-0 gap-4 p-6">
            <header className="grid gap-1 pr-8">
              <span className="text-xs font-medium text-bad">{failure.note}</span>
              <h2 className="text-lg font-semibold">{failure.text}</h2>
              <p className="text-sm text-muted">The full error returned by the tool.</p>
            </header>
            <FailureDetail detail={failure.detail} />
          </div>
        )}
      </Overlay>
    </div>
  );
}

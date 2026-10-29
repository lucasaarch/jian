'use client';

import { Check, ChevronDown, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { OrbState } from 'thinking-orbs';
import { Orb } from '@/components/ui';

/** One line of the trace. A step that went wrong stays in it, marked, with what went wrong. */
export type ThoughtStep = {
  key: string;
  text: string;
  status: 'running' | 'done' | 'failed';
  /** Why it failed, shown beside it. */
  note?: string;
};

/** Seconds as the line reads them: tenths under a minute, then minutes and seconds. */
const lasted = (seconds: number) =>
  seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;

const spoken = (seconds: number) =>
  seconds < 60
    ? `${Math.round(seconds)} seconds`
    : `${Math.floor(seconds / 60)} minutes ${Math.floor(seconds % 60)} seconds`;

const at = (moment?: string | number) =>
  moment === undefined ? undefined : typeof moment === 'number' ? moment : Date.parse(moment);

/**
 * What the agent is doing, as one line that breathes while it works and settles into how long
 * it took. The orb is its mark; the steps it went through fold beneath it, open while it works
 * and folded once it is done, a click away.
 *
 * The time comes from the run's own timestamps, not from when this line was drawn, so a reload
 * or an old turn shows how long the work took instead of starting again from zero. Adapted from
 * React Bits' ThoughtLine, drawn with the panel's orb and icons.
 */
export function ThoughtLine({
  working,
  label = 'Thinking…',
  doneLabel = 'Worked for',
  orb = 'composing',
  steps = [],
  startedAt,
  finishedAt,
}: {
  working: boolean;
  label?: string;
  doneLabel?: string;
  orb?: OrbState;
  steps?: ThoughtStep[];
  startedAt?: string | number;
  /** When the work ended; a settled line without it ends at its last known moment. */
  finishedAt?: string | number;
}) {
  const [open, setOpen] = useState(working);
  const timer = useRef<HTMLSpanElement>(null);
  const trace = useId();
  const start = at(startedAt);
  const end = at(finishedAt);
  const seconds = (now: number) => (start === undefined ? 0 : Math.max(0, (now - start) / 1000));

  // Open while it works, folded once it settles; the reader can still open it by hand.
  useEffect(() => {
    setOpen(working);
  }, [working]);

  // The clock runs on the element itself: ten updates a second would otherwise redraw the turn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seconds reads only `start`.
  useEffect(() => {
    if (!working || start === undefined) return;
    const paint = () => {
      if (timer.current) timer.current.textContent = lasted(seconds(Date.now()));
    };
    paint();
    const id = setInterval(paint, 100);

    return () => clearInterval(id);
  }, [working, start]);

  const settled = start !== undefined ? seconds(end ?? Date.now()) : undefined;
  const foldable = steps.length > 0;
  const current = working ? label : settled !== undefined ? doneLabel : 'Done';

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
        <Orb state={orb} paused={!working} />
        <span className="thought-labels" aria-hidden="true">
          <span className="thought-label working" data-active={working || undefined}>
            {label}
          </span>
          <span className="thought-label done" data-active={!working || undefined}>
            {settled !== undefined ? doneLabel : 'Done'}
          </span>
        </span>
        {start !== undefined && (
          <span ref={timer} className="thought-timer" aria-hidden="true">
            {lasted(working ? seconds(Date.now()) : (settled ?? 0))}
          </span>
        )}
        {foldable && <ChevronDown size={14} className="thought-chevron" aria-hidden="true" />}
        <span className="sr-only" role="status">
          {working || settled === undefined ? current : `${doneLabel} ${spoken(settled)}`}
        </span>
      </button>
      {foldable && (
        <div className="thought-trace" id={trace} inert={!open}>
          <ol>
            {steps.map((step) => (
              <li key={step.key} data-status={step.status} title={step.note}>
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
                {step.note && <span className="thought-note">{step.note}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

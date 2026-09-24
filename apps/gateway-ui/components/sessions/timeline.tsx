'use client';

import { Check, ChevronDown, CircleSlash, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import type { ToolStep } from '../../lib/api';
import { Orb } from '../ui';
import { toolLabels, toolOrbs } from './progress';

const labelOf = (step: ToolStep) => {
  const label = toolLabels[step.toolName] ?? step.toolName.replaceAll('_', ' ');

  return `${label[0]?.toUpperCase()}${label.slice(1)}`;
};

/** A duration as a person reads it: under a second, seconds, or minutes and seconds. */
const lasted = (from: string, to?: string) => {
  if (!to) return '';
  const ms = Date.parse(to) - Date.parse(from);

  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const marks: Record<ToolStep['status'], React.ReactNode> = {
  running: null,
  done: <Check size={11} strokeWidth={3} />,
  failed: <X size={11} strokeWidth={3} />,
  refused: <CircleSlash size={11} strokeWidth={2.5} />,
  uncertain: <TriangleAlert size={11} strokeWidth={2.5} />,
  stopped: <CircleSlash size={11} strokeWidth={2.5} />,
};

const outcomes: Partial<Record<ToolStep['status'], string>> = {
  failed: 'Failed',
  refused: 'Refused by the server',
  uncertain: 'Outcome unknown',
  stopped: 'Did not finish',
};

function Step({ step, index }: { step: ToolStep; index: number }) {
  return (
    <li
      className="timeline-step"
      data-status={step.status}
      title={step.error}
      style={{ '--i': index } as React.CSSProperties}
    >
      {/* Keyed by status, so a mark that changes (the orb becoming a tick) pops in anew. */}
      <span key={step.status} className="timeline-mark" aria-hidden="true">
        {step.status === 'running' ? (
          <Orb state={toolOrbs[step.toolName] ?? 'working'} />
        ) : (
          marks[step.status]
        )}
      </span>
      <span className="timeline-label">{labelOf(step)}</span>
      {outcomes[step.status] && <span className="timeline-outcome">{outcomes[step.status]}</span>}
      <span className="timeline-time">{lasted(step.startedAt, step.finishedAt)}</span>
    </li>
  );
}

/**
 * The tools the agent used for one answer, as a vertical timeline. A finished answer shows only
 * a summary line that opens it; while the agent works the timeline stays open and grows, with
 * the orb on the step in progress. On the agent's side of a conversation read over its
 * shoulder, the timeline mirrors, marks on the right, like everything else on that side.
 */
export function ToolTimeline({ steps, live = false }: { steps: ToolStep[]; live?: boolean }) {
  const [open, setOpen] = useState(false);

  if (!steps.length) return null;

  const first = steps[0]?.startedAt ?? '';
  const last = steps
    .map((step) => step.finishedAt ?? '')
    .sort()
    .at(-1);
  const failed = steps.filter((step) => ['failed', 'uncertain', 'refused'].includes(step.status));
  const expanded = live || open;

  return (
    <div
      className="tool-timeline"
      data-live={live}
      style={{ '--n': steps.length } as React.CSSProperties}
    >
      {!live && (
        <button
          type="button"
          className="timeline-summary"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {steps.length === 1 ? 'Used 1 tool' : `Used ${steps.length} tools`}
          {last && ` · ${lasted(first, last)}`}
          {failed.length > 0 && <span className="timeline-failed"> · {failed.length} failed</span>}
          <ChevronDown size={14} className="timeline-chevron" aria-hidden="true" />
        </button>
      )}
      {/* Always rendered, so closing can play out; closed, it is out of reach of focus. */}
      <div className="timeline-wrap" data-open={expanded} inert={!expanded}>
        <ol className="timeline">
          {steps.map((step, index) => (
            <Step key={step.toolCallId} step={step} index={index} />
          ))}
        </ol>
      </div>
    </div>
  );
}

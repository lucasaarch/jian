'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ToolStep } from '../../lib/api';
import type { ThoughtStep } from './thought-line';
import { thoughtOf } from './trace';

/**
 * Where an opened tool reads its whole step, when a brief timeline cut it. Given by the
 * conversation that read the timeline; without one (the crew drawer, a draft, a test), a tool
 * shows what its step has.
 */
export type StepDetails = {
  /** The step whole, read once: a later call for the same tool gets the same answer. */
  read(toolCallId: string): Promise<ToolStep>;
  /** The step whole if it has been read, so a tool opened again draws it at once. */
  known(toolCallId: string): ToolStep | undefined;
};

export const StepDetailsContext = createContext<StepDetails | undefined>(undefined);

/**
 * Whole steps by tool call, for one conversation. A step still running is read again next time:
 * what it answers is not final. A read that failed is forgotten, so the next opening tries again.
 */
export function readOnce(read: (toolCallId: string) => Promise<ToolStep>): StepDetails {
  const steps = new Map<string, ToolStep>();
  const reading = new Map<string, Promise<ToolStep>>();

  return {
    known: (toolCallId) => steps.get(toolCallId),
    read: (toolCallId) => {
      const known = steps.get(toolCallId);
      if (known) return Promise.resolve(known);
      const under = reading.get(toolCallId);
      if (under) return under;
      const asked = read(toolCallId)
        .then((step) => {
          if (step.status !== 'running') steps.set(toolCallId, step);
          return step;
        })
        .finally(() => reading.delete(toolCallId));
      reading.set(toolCallId, asked);
      return asked;
    },
  };
}

/** The line as the list has it, with what the whole step says of the tool laid over it. */
function over(line: ThoughtStep, whole: ToolStep): ThoughtStep {
  const read = thoughtOf(whole);
  return {
    ...line,
    brief: undefined,
    ...(read.input ? { input: read.input } : {}),
    ...(read.output ? { output: read.output } : {}),
    ...(read.diff ? { diff: read.diff } : {}),
    ...(read.detail ? { detail: read.detail } : {}),
  };
}

export type FullStep = { step: ThoughtStep; state?: 'reading' | 'failed' };

/**
 * An opened tool as it is drawn: whole once read, the list's preview until then or if it cannot
 * be read. Only a step marked brief is read, and only while it is open.
 */
export function useFullStep(line: ThoughtStep, open: boolean): FullStep {
  const details = useContext(StepDetailsContext);
  const wanted = Boolean(open && line.brief && details);
  const known = wanted ? details?.known(line.key) : undefined;
  const [read, setRead] = useState<{ key: string; status: string; step?: ToolStep }>();
  const failed = read?.key === line.key && read.status === line.status && !read.step;

  useEffect(() => {
    if (!wanted || !details || known) return;
    let gone = false;
    const told = (step?: ToolStep) => {
      if (!gone) setRead({ key: line.key, status: line.status, step });
    };
    details.read(line.key).then(told, () => told());
    return () => {
      gone = true;
    };
  }, [wanted, details, known, line.key, line.status]);

  if (!wanted) return { step: line };
  const whole =
    known ?? (read?.key === line.key && read.status === line.status ? read.step : undefined);
  if (whole) return { step: over(line, whole) };
  return { step: line, state: failed ? 'failed' : 'reading' };
}

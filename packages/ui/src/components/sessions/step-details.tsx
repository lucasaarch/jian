'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ToolStep } from '../../lib/api';
import type { ThoughtStep } from './thought-line';
import { thoughtOf } from './trace';

/**
 * Where an opened tool reads its whole step, when a brief timeline cut it: by the turn that
 * called it and its call id, since a model may use the same id in another turn. Given by the
 * conversation that read the timeline; without one (the crew drawer, a draft, a test), a tool
 * shows what its step has.
 */
export type StepDetails = {
  /** The step whole, read once: a later call for the same tool gets the same answer. */
  read(runId: string, toolCallId: string): Promise<ToolStep>;
  /** The step whole if it has been read, so a tool opened again draws it at once. */
  known(runId: string, toolCallId: string): ToolStep | undefined;
};

export const StepDetailsContext = createContext<StepDetails | undefined>(undefined);

/**
 * Whole steps by turn and tool call, for one conversation. A step still running is read again
 * next time: what it answers is not final. A read that failed is forgotten, so the next opening
 * tries again.
 */
export function readOnce(
  read: (runId: string, toolCallId: string) => Promise<ToolStep>,
): StepDetails {
  const steps = new Map<string, ToolStep>();
  const reading = new Map<string, Promise<ToolStep>>();
  const keyOf = (runId: string, toolCallId: string) => `${runId}:${toolCallId}`;

  return {
    known: (runId, toolCallId) => steps.get(keyOf(runId, toolCallId)),
    read: (runId, toolCallId) => {
      const key = keyOf(runId, toolCallId);
      const known = steps.get(key);
      if (known) return Promise.resolve(known);
      const under = reading.get(key);
      if (under) return under;
      const asked = read(runId, toolCallId)
        .then((step) => {
          if (step.status !== 'running') steps.set(key, step);
          return step;
        })
        .finally(() => reading.delete(key));
      reading.set(key, asked);
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
  const { run, key, status } = line;
  const wanted = Boolean(open && line.brief && details && run);
  const known = wanted && run ? details?.known(run, key) : undefined;
  // What a read answered holds for the line it was asked for, as it was then.
  const attempt = `${run}:${key}:${status}`;
  const [read, setRead] = useState<{ attempt: string; step?: ToolStep }>();
  // Closing forgets a failure: opening again is a new try, drawn as reading until it answers.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setRead(undefined);
  }

  useEffect(() => {
    if (!wanted || !details || !run || known) return;
    let gone = false;
    const told = (step?: ToolStep) => {
      if (!gone) setRead({ attempt, step });
    };
    details.read(run, key).then(told, () => told());
    return () => {
      gone = true;
    };
  }, [wanted, details, known, run, key, attempt]);

  if (!wanted) return { step: line };
  const answered = read?.attempt === attempt ? read : undefined;
  const whole = known ?? answered?.step;
  if (whole) return { step: over(line, whole) };
  return { step: line, state: answered ? 'failed' : 'reading' };
}

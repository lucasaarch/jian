'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';

/** How long typing rests before what was typed is saved, in milliseconds. */
const REST_MS = 700;

export type SaveState =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved' }
  | { state: 'failed'; reason: string };

/**
 * Saves `value` once it stops changing, with no button to press. Saves run one at a time, in the
 * order they were asked for, each with the newest value; one still waiting when the screen
 * closes is made at once rather than lost. `valid` keeps a value that would be refused — a
 * required field left empty — from being sent.
 */
export function useAutoSave<T>(
  value: T,
  save: (value: T) => Promise<void>,
  valid: (value: T) => boolean = () => true,
): SaveState {
  const [status, setStatus] = useState<SaveState>({ state: 'idle' });
  const queue = useRef(Promise.resolve());
  const waiting = useRef(false);
  const mounted = useRef(true);
  // Compared by content, so a value rebuilt on each render is not a change.
  const shape = JSON.stringify(value);
  const [first] = useState(shape);

  const run = useEffectEvent(() => {
    waiting.current = false;
    const next = value;
    if (mounted.current) setStatus({ state: 'saving' });
    queue.current = queue.current
      .then(() => save(next))
      .then(
        () => {
          if (mounted.current) setStatus({ state: 'saved' });
        },
        (failure: unknown) => {
          if (!mounted.current) return;
          setStatus({
            state: 'failed',
            reason: failure instanceof Error ? failure.message : 'Not saved.',
          });
        },
      );
  });
  const changed = useEffectEvent((now: string) => now !== first && valid(value));

  useEffect(() => {
    if (!changed(shape)) return;
    waiting.current = true;
    const timer = setTimeout(() => run(), REST_MS);
    return () => clearTimeout(timer);
  }, [shape]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (waiting.current) run();
    };
  }, []);

  return status;
}

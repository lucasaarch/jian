'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Long enough that a word being typed is not a save; short enough to feel immediate. */
export const TYPING_DELAY_MS = 800;

/**
 * Saves shortly after the last change, one save at a time. A change during a save waits for it
 * and then saves again, so the newest state always lands last and a save never races another
 * with a stale version. Whatever is still pending is saved when the screen goes away.
 */
export function useAutosave(save: () => Promise<void>) {
  const latest = useRef(save);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const running = useRef<Promise<void>>(Promise.resolve());
  const dirty = useRef(false);

  latest.current = save;

  const flush = useCallback(() => {
    clearTimeout(timer.current);

    if (!dirty.current) {
      return running.current;
    }

    dirty.current = false;
    running.current = running.current.then(() => latest.current()).catch(() => {});

    return running.current;
  }, []);

  const schedule = useCallback(
    (delay = TYPING_DELAY_MS) => {
      dirty.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [flush],
  );

  useEffect(() => {
    // Closing the tab or leaving the screen mid-pause still saves what was typed.
    const leave = () => void flush();

    window.addEventListener('pagehide', leave);

    return () => {
      window.removeEventListener('pagehide', leave);
      void flush();
    };
  }, [flush]);

  return { schedule, flush };
}

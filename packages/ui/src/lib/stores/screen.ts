'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * What is on show in the conversation's place. Counts, not flags, so one screen leaving as
 * another arrives never brings back what the second keeps away.
 * - `covers`: screens with no Inspector beside them (pull requests, settings, schedules). Its
 *   tabs and whether it was open stay as they were, for the conversation to find on its return.
 * - `pages`: of those, the ones drawn over the whole app (kit `Page`), with the app's panes left
 *   mounted underneath and out of reach.
 */
const useScreen = create<{ covers: number; pages: number }>()(() => ({ covers: 0, pages: 0 }));

const count = (key: 'covers' | 'pages', by: 1 | -1) =>
  useScreen.setState((state) => ({ [key]: state[key] + by }));

/** Keeps the Inspector away while the calling screen is on show (and `active`). */
export function useNoInspector(active = true) {
  useEffect(() => {
    if (!active) return;
    count('covers', 1);
    return () => count('covers', -1);
  }, [active]);
}

/** For a page over the whole app: no Inspector, and the panes beneath it out of reach. */
export function useCoveringPage() {
  useNoInspector();
  useEffect(() => {
    count('pages', 1);
    return () => count('pages', -1);
  }, []);
}

/** Whether a screen on show has no room for the Inspector, nor for the button that opens it. */
export const useInspectorAway = () => useScreen((state) => state.covers > 0);

/** Whether a page is over the app's panes, which keyboard and screen reader must then skip. */
export const usePageCovering = () => useScreen((state) => state.pages > 0);

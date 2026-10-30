'use client';

import { useSyncExternalStore } from 'react';

/** The width below which the sidebar and what it opens take turns, as the `phone:` styles do. */
const PHONE = '(max-width: 760px)';

const subscribe = (change: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
};

/**
 * Whether the panel is on a phone's width. False on the server and in the first render, which
 * then agree; the real answer follows at once.
 */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

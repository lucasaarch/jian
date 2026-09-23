'use client';

import { useSyncExternalStore } from 'react';

/**
 * What the page is showing right now, resolved: the mode the owner picked, or the system's when
 * they left it on System; and whether they asked for less motion. For a component that draws
 * itself rather than reading the stylesheet, and so has to be told.
 */
function read() {
  const root = document.documentElement;
  const mode = root.dataset.mode;
  const dark =
    mode === 'dark' ||
    (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const still =
    root.dataset.motion === 'reduced' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return `${dark ? 'dark' : 'light'}:${still ? 'still' : 'moving'}`;
}

function subscribe(change: () => void) {
  const observer = new MutationObserver(change);
  const queries = ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)'].map(
    (query) => window.matchMedia(query),
  );

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-mode', 'data-motion'],
  });
  for (const query of queries) query.addEventListener('change', change);

  return () => {
    observer.disconnect();
    for (const query of queries) query.removeEventListener('change', change);
  };
}

export function useAppearance() {
  const [mode, motion] = useSyncExternalStore(subscribe, read, () => 'light:moving').split(':');

  return { dark: mode === 'dark', still: motion === 'still' };
}

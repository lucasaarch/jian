'use client';

import { useEffect } from 'react';

/**
 * The navigation a phone opens over the screen: while it is open, the page behind stops
 * scrolling, focus starts in it and stays in it, Escape closes it, and a screen grown past a
 * phone's width closes it too. Focus goes back where it was when it closes.
 */
export function useMobileNavigation(open: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const sidebar = document.getElementById('main-navigation');
    const focusable = () =>
      Array.from(
        sidebar?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => focusable()[0]?.focus({ preventScroll: true }));
    const desktop = window.matchMedia('(min-width: 761px)');
    const resize = () => {
      if (desktop.matches) setOpen(false);
    };
    const close = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') setOpen(false);
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !sidebar?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !sidebar?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', close);
    desktop.addEventListener('change', resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', close);
      desktop.removeEventListener('change', resize);
      document.body.style.overflow = previousOverflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, setOpen]);
}

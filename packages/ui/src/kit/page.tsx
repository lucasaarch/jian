'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { useCoveringPage } from '../lib/stores/screen';

/** Something open over the page that takes Escape for itself. */
const FLOATING = '[role=dialog], [aria-modal=true], [role=menu], [role=listbox]';

/**
 * A screen that takes the app's place, sidebar and conversation both, as settings and schedules
 * do: its own list where the sidebar was, with the way back at its top, and what it opens where
 * the conversation was. Not a pane over the app: nothing is blurred behind it, and the host's
 * title bar stays over its top, as it is over the sidebar's. The conversation stays mounted
 * underneath, out of reach, with no Inspector, so coming back finds it as it was. Escape goes
 * back, unless a dialog or a menu of its own is open.
 */
export function Page({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** What assistive technology calls it. */
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <Shown onClose={onClose} title={title}>
      {children}
    </Shown>
  );
}

function Shown({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useCoveringPage();
  useEffect(() => {
    // Where the keys were is under it now: they start here, as a dialog's would.
    root.current?.focus({ preventScroll: true });
    const keys = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector(FLOATING)) return;
      close.current();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, []);

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label={title}
      data-app-page
      // Over the app's panes, under what a host draws in its title bar (z-30) and anything
      // that floats (z-40 and up). Fixed, so it is the box a host keeps its panel in.
      className="fixed inset-0 z-[25] flex min-h-0 bg-canvas text-ink outline-none"
    >
      {children}
    </section>
  );
}

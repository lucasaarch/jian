'use client';

import { X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { iconButton } from '../../kit/icon-button';
import { useCrew } from '../../lib/stores/crew';
import { useInspectorHosted } from './inspector-host';

/**
 * The Inspector's first line, at the top of the window: what it follows, quietly, then its
 * options and the way to put it away, clear of the window's buttons a host draws there.
 */
export function InspectorBar({
  children,
  options,
  closer,
  spread = false,
}: {
  children: ReactNode;
  options?: ReactNode;
  /** What it holds takes the whole line, with nothing pushing the options to the end. */
  spread?: boolean;
  /** Focused when the Inspector opens, so the keyboard is in it and Escape is at hand. */
  closer: RefObject<HTMLButtonElement | null>;
}) {
  const close = useCrew((state) => state.close);
  const hosted = useInspectorHosted();

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 pr-[calc(var(--window-controls,0px)+var(--inspector-inset))] pl-(--inspector-inset) text-muted">
      {children}
      {!spread && <span className="flex-1" />}
      {/* Nothing to hold, it takes no place: an empty one would still cost the line its gap. */}
      {(options || !hosted) && (
        <span className="flex items-center gap-0.5">
          {options}
          {!hosted && (
            <button
              ref={closer}
              type="button"
              aria-label="Close"
              className={iconButton}
              onClick={close}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * What the Inspector follows, by name, and what is said of it: it stays while its parts scroll.
 * It lines up with what it heads, at `--inspector-content-inset` where a view reads further in.
 */
export function InspectorHeader({
  title,
  flush = false,
  children,
}: {
  title: string;
  /** With no bar of its own above it, it keeps its own room under the tabs. */
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <header
      className={`grid shrink-0 gap-3 border-b border-glass-edge px-[var(--inspector-content-inset,var(--inspector-inset))] pb-5 ${flush ? 'pt-4' : 'pt-1'}`}
    >
      <h2 className="text-[17px] leading-snug font-semibold tracking-tight text-balance text-ink">
        {title}
      </h2>
      {children}
    </header>
  );
}

/**
 * Everything under the heading, the only part of the Inspector that scrolls. Positioned, so it is
 * what places what is absolute inside it: a scroller clips only what it places, and a screen
 * reader's label (`sr-only`) far down a long tree would otherwise be placed by the Inspector,
 * below the window, where it let the whole app scroll.
 */
export function InspectorBody({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6 ${className}`}>
      {children}
    </div>
  );
}

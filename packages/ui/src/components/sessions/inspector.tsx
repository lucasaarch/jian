'use client';

import { X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useCrew } from '../../lib/stores/crew';
import { useInspectorHosted } from './inspector-host';

/** A button of the Inspector's top line: its options, its close. */
export const barButton =
  'grid size-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink data-popup-open:bg-glass-press data-popup-open:text-ink';

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
              className={barButton}
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

/** What the Inspector follows, by name, and what is said of it: it stays while its parts scroll. */
export function InspectorHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="grid shrink-0 gap-3 border-b border-glass-edge px-(--inspector-inset) pt-1 pb-5">
      <h2 className="text-[17px] leading-snug font-semibold tracking-tight text-balance text-ink">
        {title}
      </h2>
      {children}
    </header>
  );
}

/** Everything under the heading, the only part of the Inspector that scrolls. */
export function InspectorBody({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6 ${className}`}>
      {children}
    </div>
  );
}

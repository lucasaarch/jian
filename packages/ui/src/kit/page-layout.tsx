'use client';

import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { iconButton } from './icon-button';

/*
 * The one anatomy of a screen that is read or edited in the conversation's place, or inside a
 * kit `Page` (settings, schedules, activity, skills, memories): a column under the title bar, a
 * heading, an optional toolbar, then sections of cards. Every edge in it is the column's: the
 * heading, a section's title and a card all start on the same line, so nothing stands a few
 * pixels in from the rest. A screen built around a table edge to edge, as the pull requests
 * are, is the one kind outside it.
 */

/** A card's ground: flat and bordered, as a settings card is. Its insides keep `p-4`. */
export const surfaceCard = 'rounded-xl border border-glass-edge bg-glass-hover';

/**
 * The scrolling column of such a screen. Rows of settings and forms read best narrow, at 40rem;
 * what lies side by side (cards, a map, figures) takes `wide`, 72rem. It starts under the host's
 * title bar, which runs over the whole window's top.
 */
export function PageBody({
  wide = false,
  label,
  labelledBy,
  className = '',
  children,
}: {
  wide?: boolean;
  label?: string;
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`scroll-inset min-h-0 min-w-0 flex-1 overflow-y-auto px-10 pt-[calc(var(--chrome-top,0px)+2.25rem)] pb-14 phone:px-4 phone:pt-[calc(var(--chrome-top,0px)+0.75rem)] ${className}`}
    >
      <div
        className={`mx-auto grid grid-cols-1 gap-7 phone:gap-5 ${wide ? 'max-w-[72rem]' : 'max-w-[40rem]'}`}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * The screen's heading: its name, and across from it what acts on the whole screen (Create,
 * Import, Edit). A screen opened from a list inside another (one skill) leads with the way back,
 * an arrow alone. A line under it can say what the screen is.
 */
export function PageHeading({
  title,
  id,
  description,
  actions,
  onBack,
  backLabel = 'Back',
}: {
  title: ReactNode;
  id?: string;
  description?: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <header className="grid min-w-0 grid-cols-1 gap-1.5">
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        {onBack && (
          <button
            type="button"
            aria-label={backLabel}
            onClick={onBack}
            className={`${iconButton} -ml-1.5`}
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        )}
        <h1
          id={id}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-xl font-semibold tracking-tight text-ink"
        >
          {title}
        </h1>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="text-sm leading-relaxed text-muted">{description}</p>}
    </header>
  );
}

/**
 * The row under the heading that narrows what the screen shows: a search that takes the room
 * left, then its filters. Controls in it are 2rem tall, as the heading's actions are.
 */
export function PageToolbar({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>;
}

/** A section's quiet title, with a note or a control that changes it at the right. */
export function SectionHeading({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex min-h-7 items-center justify-between gap-4">
      {title && <h2 className="text-xs font-medium text-muted">{title}</h2>}
      {children}
    </header>
  );
}

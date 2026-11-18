'use client';

import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { iconButton } from './icon-button';

/*
 * The one anatomy of every screen that is read or edited in the conversation's place (schedules,
 * Artifacts, pull requests, activity) or inside a kit `Page` (settings, skills, memories): a
 * column under the title bar, one width for all, a heading, an optional toolbar that stays in
 * view as the column scrolls, then sections of cards. Every edge in it is the column's: the
 * heading, a section's title and a card all start on the same line, so nothing stands a few
 * pixels in from the rest. A table lies in a card too. `.agents/skills/page-anatomy` says how a
 * new screen is built of it.
 */

/** A card's ground: flat and bordered, as a settings card is. Its insides keep `p-4`. */
export const surfaceCard = 'rounded-xl border border-glass-edge bg-glass-hover';

/**
 * The scrolling column of such a screen, 60rem at most on every one of them: a screen of rows
 * and one of cards side by side are as wide, so going from one to another nothing jumps. It
 * scrolls under the host's title bar, which runs over the whole window's top, never beneath it:
 * what scrolls away goes out of sight at the bar's edge, where the toolbar stays.
 */
export function PageBody({
  label,
  labelledBy,
  className = '',
  children,
}: {
  label?: string;
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`scroll-inset mt-(--chrome-top,0px) min-h-0 min-w-0 flex-1 overflow-y-auto px-10 pt-9 pb-14 phone:px-4 phone:pt-3 ${className}`}
    >
      <div className="mx-auto grid max-w-[60rem] grid-cols-1 gap-7 phone:gap-5">{children}</div>
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
 * left, then its filters. Controls in it are 2rem tall, as the heading's actions are. It stays
 * at the column's top while what it narrows scrolls away under it, on a ground that hides what
 * passes there; the room it keeps around its controls is taken back from the gap around it.
 */
export function PageToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 -my-2 flex min-w-0 flex-wrap items-center gap-2 bg-canvas py-2">
      {children}
    </div>
  );
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

'use client';

import { ArrowLeft, ArrowUp } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useAppearance } from '../lib/appearance';
import { useLayout } from '../lib/stores/layout';
import { FloatButton } from './float-button';
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
 * How far a page is scrolled, in px, before its way back to the top shows: about
 * a heading's height, so it never offers a trip of a few lines.
 */
const TO_TOP_AFTER_PX = 96;

/**
 * The scrolling column of such a screen, 60rem at most on every one of them: a screen of rows
 * and one of cards side by side are as wide, so going from one to another nothing jumps. It runs
 * up under the host's title bar, which has nothing of its own over a page: what scrolls away
 * goes out at the window's top, uncovered, until the toolbar gets there and docks in the bar's
 * place (`PageToolbar`). On a phone the title bar has buttons across it, so the page starts under
 * it instead. The room above the heading is the column's, not the scroller's: a sticky box stops
 * at its scroller's padding.
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
  const scroller = useRef<HTMLElement>(null);
  const { still } = useAppearance();
  // A boolean, so scrolling draws only when it flips.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const page = scroller.current;
    if (!page) return;
    // A toolbar docked at the top, with the page scrolling under it, takes its ground and line;
    // until it gets there it has neither, and covers nothing. Set on the element, not through
    // React state, so scrolling renders nothing; a toolbar drawn anew picks it up at the next
    // scroll, which narrowing the list also causes when it shortens the page.
    const mark = () => {
      const top = page.getBoundingClientRect().top;
      for (const bar of page.querySelectorAll<HTMLElement>('[data-page-toolbar]')) {
        const docked = page.scrollTop > 0 && bar.getBoundingClientRect().top - top < 1;
        bar.toggleAttribute('data-docked', docked);
      }
      setScrolled(page.scrollTop > TO_TOP_AFTER_PX);
    };
    mark();
    page.addEventListener('scroll', mark, { passive: true });
    return () => page.removeEventListener('scroll', mark);
  }, []);
  return (
    <section
      ref={scroller}
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`page-scroller min-h-0 min-w-0 flex-1 overflow-y-auto px-10 phone:mt-(--chrome-top,0px) phone:px-4 ${className}`}
    >
      <div className="mx-auto grid max-w-[60rem] grid-cols-1 gap-7 pb-14 pt-[calc(var(--chrome-top,0px)+2.25rem)] phone:gap-5 phone:pt-3">
        {children}
      </div>
      {/* A sticky box with no height of its own rides the scroller's bottom edge, so the button
          stays inside the page (not over the sidebar), clear of the scrollbar and, on a phone,
          of the home bar. */}
      <div className="sticky bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] z-[2] h-0">
        <FloatButton
          className="absolute right-0 bottom-0"
          shown={scrolled}
          label="Scroll to top"
          onClick={() =>
            scroller.current?.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' })
          }
        >
          <ArrowUp size={16} aria-hidden="true" />
        </FloatButton>
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
 * The quiet way back, in words: an arrow and where it leads, 2rem tall. Above the heading of a
 * page opened from a screen's list ("Plugins" over one skill), and at the top of a room's list.
 * It starts on the column's edge; a list that insets its rows passes the same inset.
 */
export function BackLink({
  onClick,
  className = '',
  children,
}: {
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 w-fit items-center gap-2 text-[13px] text-muted transition-colors hover:text-ink ${className}`}
    >
      <ArrowLeft size={15} aria-hidden="true" />
      {children}
    </button>
  );
}

/**
 * The row under the heading that narrows what the screen shows: a search that takes the room
 * left, then its filters. Controls in it are 2rem tall, as the heading's actions are. Scrolled up
 * to the top, it docks in the title bar's place, as tall as it, and only then takes a ground and
 * a line across the page (`page-toolbar`) for what it narrows to scroll away under. The room it
 * keeps around its controls is taken back from the gap around it.
 */
export function PageToolbar({ children }: { children: ReactNode }) {
  const away = useLayout((state) => state.chatList);
  return (
    <div
      data-page-toolbar
      data-sidebar-away={away || undefined}
      className="page-toolbar sticky top-0 z-20 -my-[max(0px,calc((var(--chrome-top,0px)-2rem)/2))] flex min-h-(--chrome-top,0px) min-w-0 flex-wrap items-center gap-2 py-1 phone:-my-2 phone:min-h-0 phone:py-2"
    >
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

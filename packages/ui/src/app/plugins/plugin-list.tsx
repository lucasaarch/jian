'use client';

import { BadgeCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { SectionHeading, StatusPill } from '../../kit';

/** One row of Plugins, whatever it is underneath: a connector, and a skill once they move here. */
export type PluginItem = {
  id: string;
  icon: ReactNode;
  name: string;
  /** Provided by Jian, which the badge beside the name says. */
  verified: boolean;
  description: string;
  /** What kind of thing it is and whose: "Connector · By Linear". */
  meta: string;
  /** How it stands, in a word, when that is worth saying: "Connected". */
  status?: string;
};

/** The badge of what Jian provides, beside a name. */
export function VerifiedBadge() {
  return <BadgeCheck size={14} role="img" aria-label="Verified" className="shrink-0 text-muted" />;
}

/**
 * The mark's tile, as a settings card draws it. Without a hairline under it: the line parts the
 * words of one row from the next, and starts where they do.
 */
const tile =
  'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-glass-edge bg-ink/5 text-ink';

/**
 * No hairline under the last row of a column: the last row, and beside it the one before when
 * the two share the last line of two columns.
 */
const lastRows =
  'group-last:border-transparent @min-[44rem]:group-[:nth-last-child(2):nth-child(odd)]:border-transparent';

/**
 * Plugins as rows parted by a hairline, two columns of them where the page is wide enough and
 * one where it is not: measured on the list's own width, since the sidebar takes its share of
 * the window. A row opens what it names.
 */
export function PluginList({
  label,
  items,
  onOpen,
}: {
  label: string;
  items: PluginItem[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="@container">
      <ul aria-label={label} className="grid grid-cols-2 gap-x-10 @max-[44rem]:grid-cols-1">
        {items.map((item) => (
          <li key={item.id} className="group min-w-0">
            <button
              type="button"
              onClick={() => onOpen(item.id)}
              // The ground under a hovered row runs half a rem past the words on each side, so
              // the words themselves stay on the column's edge.
              className="-mx-2 flex w-[calc(100%+1rem)] min-w-0 items-start gap-3 rounded-lg px-2 pt-3 text-left transition-colors hover:bg-glass-hover focus-visible:bg-glass-hover focus-visible:outline-none"
            >
              <span aria-hidden="true" className={tile}>
                {item.icon}
              </span>
              <span
                className={`grid min-w-0 flex-1 grid-cols-1 gap-0.5 border-b border-glass-edge pb-3 ${lastRows}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                    {item.name}
                  </span>
                  {item.verified && <VerifiedBadge />}
                  {item.status && <StatusPill tone="good">{item.status}</StatusPill>}
                </span>
                <span className="truncate text-xs text-muted">{item.description}</span>
                <span className="truncate text-xs text-muted/70">{item.meta}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A group of plugins under its quiet title, with what leads to the rest of them at its right. */
export function PluginSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="grid grid-cols-1 gap-1">
      <SectionHeading title={title}>{action}</SectionHeading>
      {children}
    </section>
  );
}

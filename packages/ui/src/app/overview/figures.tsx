'use client';

import type { ReactNode } from 'react';
import { Skeleton } from '../../kit';

/** A card of the Overview: flat inside the page, as a settings card is. */
export const card = 'rounded-xl border border-glass-edge bg-glass-hover';

/**
 * A number with its label and a mark, as the tiles across the top of each part show it. Without
 * the number yet, a block holds its line: `h-5` and `my-1` make the 1.75rem the figure takes.
 */
export function Tile({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  /** Left out while the numbers are on their way. */
  children?: ReactNode;
}) {
  return (
    <div className={`${card} grid min-w-0 gap-2.5 p-4`}>
      <span className="text-muted" aria-hidden="true">
        {icon}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-xs text-muted">{label}</span>
        <strong className="truncate text-xl font-semibold tracking-tight text-ink tabular-nums">
          {children ?? <Skeleton className="my-1 h-5 w-16" />}
        </strong>
      </span>
    </div>
  );
}

/** Four tiles abreast, two on a phone. */
export function Tiles({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-4 gap-2.5 phone:grid-cols-2">{children}</div>;
}

/** A part of the Overview under its quiet title, with what changes it at the right. */
export function Part({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-1 gap-3" aria-label={title}>
      <header className="flex min-h-7 items-center justify-between gap-4 px-1">
        <h2 className="font-sans text-sm font-semibold tracking-tight text-ink">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** How much of a whole a part took, as a thin bar in the ink. */
export function Share({ part, whole }: { part: number; whole: number }) {
  return (
    <span className="block h-1 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
      <span
        className="block h-full rounded-full bg-ink/70"
        style={{ width: `${whole ? Math.min(100, (part / whole) * 100) : 0}%` }}
      />
    </span>
  );
}

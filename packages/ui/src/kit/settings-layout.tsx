'use client';

import type { ReactNode } from 'react';

export type SettingsPage = { id: string; label: string; icon: ReactNode; group?: string };

/**
 * The inside of a settings overlay: its pages down the left, grouped, the open one on the right
 * under its own heading. Small enough that every page is a click away.
 */
export function SettingsLayout({
  heading,
  pages,
  current,
  onSelect,
  children,
}: {
  heading: ReactNode;
  pages: SettingsPage[];
  current: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const groups = [...new Set(pages.map((page) => page.group ?? ''))];
  const open = pages.find((page) => page.id === current);
  return (
    <div className="grid size-full grid-cols-[14.5rem_minmax(0,1fr)]">
      <nav
        aria-label="Settings"
        className="flex flex-col gap-4 overflow-y-auto border-r border-glass-edge p-3 pt-5"
      >
        <div className="px-2.5 text-sm font-semibold">{heading}</div>
        {groups.map((group) => (
          <div key={group} className="grid gap-0.5">
            {group && (
              <span className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">
                {group}
              </span>
            )}
            {pages
              .filter((page) => (page.group ?? '') === group)
              .map((page) => (
                <button
                  key={page.id}
                  type="button"
                  onClick={() => onSelect(page.id)}
                  aria-current={page.id === current ? 'page' : undefined}
                  className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-muted transition-colors hover:bg-glass-hover hover:text-ink aria-[current=page]:bg-glass-press aria-[current=page]:text-ink"
                >
                  <span className="grid size-5 place-items-center">{page.icon}</span>
                  {page.label}
                </button>
              ))}
          </div>
        ))}
      </nav>
      <section aria-label={open?.label} className="min-h-0 overflow-y-auto px-9 pt-8 pb-12">
        <h2 className="mb-6 text-xl font-semibold tracking-tight">{open?.label}</h2>
        {children}
      </section>
    </div>
  );
}

/** A block of settings on a page, with what it is about. */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8 grid gap-3">
      <header className="grid gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-[13px] text-muted">{description}</p>}
      </header>
      <div className="grid gap-3 rounded-2xl border border-glass-edge bg-glass-hover p-4">
        {children}
      </div>
    </section>
  );
}

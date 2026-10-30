'use client';

import { Dialog } from '@base-ui/react/dialog';
import { ArrowLeft, ChevronLeft, Search } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { bareInput } from './text-field';

export type SettingsPage = {
  id: string;
  label: string;
  icon: ReactNode;
  group?: string;
  /** Other words someone may search for it by. */
  keywords?: string[];
};

const found = (page: SettingsPage, query: string) => {
  const haystack = [page.label, page.group ?? '', ...(page.keywords ?? [])].join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
};

/**
 * The inside of a settings overlay: back out of it, search its pages and pick one down the left,
 * the open one on the right in a column of cards. `heading`, when given, says whose settings
 * these are: an agent's, a gateway's. On a phone the list and the open page take turns: it
 * starts on the list, or on the page when `startOnPage` says it was asked for by name.
 */
export function SettingsLayout({
  heading,
  pages,
  current,
  onSelect,
  startOnPage = false,
  children,
}: {
  heading?: ReactNode;
  pages: SettingsPage[];
  current: string;
  onSelect: (id: string) => void;
  startOnPage?: boolean;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [reading, setReading] = useState(startOnPage);
  const shown = pages.filter((page) => found(page, query));
  const groups = [...new Set(shown.map((page) => page.group ?? ''))];
  const open = pages.find((page) => page.id === current);
  const select = (id: string) => {
    setReading(true);
    onSelect(id);
  };

  return (
    <div
      data-reading={reading}
      className="group/settings grid size-full grid-cols-[15rem_minmax(0,1fr)] phone:grid-cols-1"
    >
      <nav
        aria-label="Settings"
        className="flex min-h-0 flex-col gap-3 border-r border-glass-edge bg-canvas/25 p-2.5 pt-3 phone:border-0 phone:group-data-[reading=true]/settings:hidden"
      >
        <Dialog.Close className="flex h-8 w-fit items-center gap-2 px-2 text-[13px] text-muted transition-colors hover:text-ink">
          <ArrowLeft size={15} />
          Back
        </Dialog.Close>
        {heading && <div className="px-2 text-sm font-semibold">{heading}</div>}
        <label className="flex h-8 items-center gap-2 rounded-lg border border-glass-edge bg-glass-hover px-2.5 text-muted focus-within:border-ink/20">
          <Search size={14} className="shrink-0" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter opens the first page found, as typing a name and pressing it would ask.
              if (event.key === 'Enter' && shown[0]) select(shown[0].id);
            }}
            className={`${bareInput} text-[13px]`}
          />
        </label>
        <div className="grid min-h-0 content-start gap-3 overflow-y-auto">
          {groups.map((group) => (
            <div key={group} className="grid gap-0.5">
              {group && (
                <span className="px-2.5 pt-1 pb-1 text-xs font-medium text-muted">{group}</span>
              )}
              {shown
                .filter((page) => (page.group ?? '') === group)
                .map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => select(page.id)}
                    aria-current={page.id === current ? 'page' : undefined}
                    className="flex h-8 items-center phone:h-11 phone:aria-[current=page]:bg-transparent gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-ink/80 transition-colors hover:bg-glass-hover hover:text-ink aria-[current=page]:bg-glass-press aria-[current=page]:text-ink"
                  >
                    <span className="grid size-4 place-items-center text-muted">{page.icon}</span>
                    {page.label}
                  </button>
                ))}
            </div>
          ))}
          {shown.length === 0 && (
            <p className="px-2.5 py-2 text-[13px] text-muted">No setting matches.</p>
          )}
        </div>
      </nav>
      <section
        aria-label={open?.label}
        className="scroll-inset min-h-0 overflow-y-auto px-10 pt-9 pb-14 phone:px-4 phone:pt-3 phone:group-data-[reading=false]/settings:hidden"
      >
        <div className="mx-auto grid max-w-[40rem] gap-7 phone:gap-5">
          <button
            type="button"
            onClick={() => setReading(false)}
            className="-ml-1 hidden h-8 w-fit items-center gap-1 text-[13px] text-muted transition-colors hover:text-ink phone:flex"
          >
            <ChevronLeft size={16} />
            Settings
          </button>
          <h2 className="px-1 text-base font-semibold tracking-tight">{open?.label}</h2>
          {children}
        </div>
      </section>
    </div>
  );
}

/**
 * A card of settings on a page, under a quiet title. Its rows are parted by a line. A card whose
 * rows are still being read holds skeleton rows and says so through `loading`.
 */
export function SettingsGroup({
  title,
  note,
  loading,
  children,
}: {
  title?: string;
  /** Said at the right of the title, about the whole card. */
  note?: ReactNode;
  /**
   * For a card read after the page: what it is waiting for while it waits ("Loading keys…"),
   * false once it is not. The status stays in place between the two, so a screen reader hears
   * the change, and stays out of the busy card, whose words a reader holds back.
   */
  loading?: string | false;
  children: ReactNode;
}) {
  return (
    // One column that never outgrows the page: a long line is cut short in its row instead.
    <section className="grid grid-cols-1 gap-2">
      {loading !== undefined && (
        <p role="status" className="sr-only">
          {loading || ''}
        </p>
      )}
      {(title || note) && (
        <header className="flex items-baseline justify-between gap-4 px-1">
          {title && <h3 className="text-xs font-medium text-muted">{title}</h3>}
          {note && <span className="text-xs text-muted">{note}</span>}
        </header>
      )}
      <div
        aria-busy={loading ? true : undefined}
        className="divide-y divide-glass-edge rounded-xl border border-glass-edge bg-glass-hover"
      >
        {children}
      </div>
    </section>
  );
}

/**
 * One setting: what it is and what it does on the left, its control on the right. A control too
 * large for the end of a row — instructions to write — goes `below`, across the row's width.
 * Where the two cannot share a line, as on a phone, the control drops under the words; a text
 * field there takes the whole line.
 */
export function SettingsRow({
  title,
  description,
  children,
  below,
  labelId,
  descriptionId,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  below?: ReactNode;
  /** Ids for the control to be named and described by. */
  labelId?: string;
  descriptionId?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 px-4 py-3">
      <div className="flex min-h-8 min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="grid min-w-0 flex-1 basis-44 grid-cols-1 gap-0.5">
          <span id={labelId} className="text-[13px] text-ink">
            {title}
          </span>
          {description && (
            <span id={descriptionId} className="text-xs leading-snug text-muted">
              {description}
            </span>
          )}
        </div>
        {children && (
          <div className="flex shrink-0 items-center gap-2 phone:has-[input:not([type=checkbox])]:basis-full">
            {children}
          </div>
        )}
      </div>
      {below}
    </div>
  );
}

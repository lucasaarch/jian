'use client';

import { ArrowLeft, ChevronLeft } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { usePhone } from '../lib/phone';
import { useLayout } from '../lib/stores/layout';
import { PageBody, PageHeading, SectionHeading, surfaceCard } from './page-layout';
import { SearchField } from './search-field';

export type SettingsPage = {
  id: string;
  label: string;
  icon: ReactNode;
  group?: string;
  /** Other words someone may search for it by. */
  keywords?: string[];
  /** At the end of its line: a count, how it stands. */
  trailing?: ReactNode;
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
 * The inside of a page of settings (kit `Page`): where the app's sidebar was, the way back out of
 * it, a search of its pages and the list to pick one from; where the conversation was, the open
 * one in a column of cards. The list is the sidebar's width and ground, keeps `--chrome-top`
 * clear for the host's title bar as the sidebar does, and goes away with it. On a phone the list and the open
 * page take turns: it starts on the list, or on the page when `startOnPage` says it was asked for
 * by name.
 */
export function SettingsLayout({
  onBack,
  pages,
  current,
  onSelect,
  startOnPage = false,
  title,
  searchLabel = 'Search settings',
  emptyLabel = 'No setting matches.',
  backLabel = 'Settings',
  action,
  wide = false,
  ownHeading = false,
  children,
}: {
  /** Out of the page, back to the conversation. */
  onBack: () => void;
  /** What the open page is called, for a page the list does not hold, such as a new one. */
  title?: string;
  searchLabel?: string;
  emptyLabel?: string;
  /** The way back to the list, on a phone: what the list is called. */
  backLabel?: string;
  /** Across from the way back, for what can be added to the list. */
  action?: ReactNode;
  /** For a page that lays things side by side (cards, a map) instead of one column of rows. */
  wide?: boolean;
  /** The open page draws its own `PageHeading`, for actions or a way back of its own. */
  ownHeading?: boolean;
  pages: SettingsPage[];
  current: string;
  onSelect: (id: string) => void;
  startOnPage?: boolean;
  children: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [reading, setReading] = useState(startOnPage);
  const phone = usePhone();
  // Put away as the sidebar is, by the same button: a phone has no room beside it to do so.
  const collapsed = useLayout((state) => state.chatList) && !phone;
  const shown = pages.filter((page) => found(page, query));
  const groups = [...new Set(shown.map((page) => page.group ?? ''))];
  const open = pages.find((page) => page.id === current);
  const select = (id: string) => {
    setReading(true);
    onSelect(id);
  };

  return (
    <div data-reading={reading} className="group/settings flex size-full min-w-0">
      <nav
        aria-label={backLabel}
        hidden={collapsed}
        className="flex min-h-0 w-(--sidebar-width) shrink-0 flex-col gap-3 border-r border-line bg-sidebar px-2 pt-[calc(var(--chrome-top,0px)+0.5rem)] pb-2.5 phone:w-full phone:border-r-0 phone:bg-canvas phone:group-data-[reading=true]/settings:hidden"
      >
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex h-8 w-fit items-center gap-2 px-2.5 text-[13px] text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={15} />
            Back
          </button>
          {action}
        </div>
        <SearchField
          label={searchLabel}
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            // Enter opens the first page found, as typing a name and pressing it would ask.
            if (event.key === 'Enter' && shown[0]) select(shown[0].id);
          }}
        />
        {/* One column the sidebar's width, not its longest name's: an implicit `auto` column
            grows to a label that does not wrap, and the list then scrolls sideways instead of
            truncating it. The sidebar never scrolls sideways. */}
        <div className="grid min-h-0 grid-cols-1 content-start gap-3 overflow-x-hidden overflow-y-auto">
          {groups.map((group) => (
            <div key={group} className="grid grid-cols-1 gap-0.5">
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
                    <span className="min-w-0 flex-1 truncate">{page.label}</span>
                    {page.trailing}
                  </button>
                ))}
            </div>
          ))}
          {/* A list with nothing in it yet is not a search that found nothing. */}
          {shown.length === 0 && query && (
            <p className="px-2.5 py-2 text-[13px] text-muted">{emptyLabel}</p>
          )}
        </div>
      </nav>
      <PageBody
        wide={wide}
        label={title ?? open?.label}
        className="phone:group-data-[reading=false]/settings:hidden"
      >
        <button
          type="button"
          onClick={() => setReading(false)}
          className="-ml-1 hidden h-8 w-fit items-center gap-1 text-[13px] text-muted transition-colors hover:text-ink phone:flex"
        >
          <ChevronLeft size={16} />
          {backLabel}
        </button>
        {!ownHeading && <PageHeading title={title ?? open?.label} />}
        {children}
      </PageBody>
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
        <SectionHeading title={title}>
          {note && <span className="text-xs text-muted">{note}</span>}
        </SectionHeading>
      )}
      <div
        aria-busy={loading ? true : undefined}
        className={`divide-y divide-glass-edge ${surfaceCard}`}
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

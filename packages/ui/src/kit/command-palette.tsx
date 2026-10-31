'use client';

import { Dialog } from '@base-ui/react/dialog';
import { Search } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { bareInput } from './text-field';

export type Command = {
  id: string;
  title: string;
  /** Said after the title, quieter: where a chat is, when it was spoken in. */
  detail?: string;
  /** Other words someone may type for it. */
  keywords?: string[];
  icon?: ReactNode;
  /** The keys shown beside it, as the system writes them: `⌘N`, `Ctrl+N`. */
  shortcut?: string;
  run: () => void;
};

/** Every word typed is somewhere in the title or the keywords, in any order. */
function matches(command: Command, query: string): boolean {
  const haystack = [command.title, ...(command.keywords ?? [])].join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** What the palette is called and says, when it lists something other than commands. */
export type PaletteLabels = { title: string; search: string; placeholder: string; empty: string };

const commandLabels: PaletteLabels = {
  title: 'Command palette',
  search: 'Search commands',
  placeholder: 'Type a command',
  empty: 'No command matches.',
};

/**
 * Everything the app can do, one search away: typing narrows the list, the arrows move through
 * it, Enter runs the one chosen and closes the palette. The chat search is the same palette
 * listing chats.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  labels = commandLabels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
  labels?: PaletteLabels;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const shown = useMemo(
    () => commands.filter((command) => matches(command, query)),
    [commands, query],
  );

  // Each opening starts from an empty search.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onOpenChange(false);
    command.run();
  };

  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => (shown.length ? (index + step + shown.length) % shown.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(shown[active]);
    }
  };

  useEffect(() => {
    if (!open || !shown[active]) return;
    const option = document.getElementById(`${list}-${shown[active].id}`);
    if (option && viewport.current?.contains(option)) option.scrollIntoView({ block: 'nearest' });
  }, [open, active, shown, list]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        {/* Glass as the kit's menus are, the page showing through it, blurred. */}
        <Dialog.Popup className="glass fixed top-[14vh] left-1/2 z-50 w-[min(34rem,calc(100vw-3rem))] -translate-x-1/2 overflow-hidden rounded-2xl text-ink outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <Dialog.Title className="sr-only">{labels.title}</Dialog.Title>
          <div className="flex h-12 items-center gap-2.5 border-b border-glass-edge px-4">
            <Search size={15} className="shrink-0 text-muted" aria-hidden="true" />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={list}
              aria-activedescendant={shown[active] ? `${list}-${shown[active].id}` : undefined}
              aria-label={labels.search}
              placeholder={labels.placeholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={keys}
              className={`${bareInput} text-[14px]`}
            />
          </div>
          <div
            ref={viewport}
            id={list}
            role="listbox"
            aria-label={labels.title}
            className="scroll-inset grid max-h-80 gap-px overflow-y-auto p-1.5"
          >
            {shown.map((command, index) => (
              <div
                key={command.id}
                id={`${list}-${command.id}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                onMouseMove={() => setActive(index)}
                onClick={() => run(command)}
                onKeyDown={(event) => event.key === 'Enter' && run(command)}
                className="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] aria-selected:bg-glass-press"
              >
                <span className="grid size-4 shrink-0 place-items-center text-muted">
                  {command.icon}
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="truncate">{command.title}</span>
                  {command.detail && (
                    <span className="min-w-0 truncate text-xs text-muted">{command.detail}</span>
                  )}
                </span>
                {command.shortcut && (
                  <kbd className="shrink-0 rounded-md bg-ink/8 px-1.5 py-0.5 font-sans text-[11px] text-muted">
                    {command.shortcut}
                  </kbd>
                )}
              </div>
            ))}
            {shown.length === 0 && (
              <p className="px-3 py-6 text-center text-[13px] text-muted">{labels.empty}</p>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

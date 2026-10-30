'use client';

import { Dialog } from '@base-ui/react/dialog';
import { Search } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from 'react';

export type Command = {
  id: string;
  title: string;
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

/**
 * Everything the app can do, one search away: typing narrows the list, the arrows move through
 * it, Enter runs the one chosen and closes the palette.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useId();
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

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/15 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="glass-strong fixed top-[14vh] left-1/2 z-50 w-[min(36rem,calc(100vw-3rem))] -translate-x-1/2 overflow-hidden rounded-2xl text-ink outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-3 border-b border-glass-edge px-4">
            <Search size={16} className="shrink-0 text-muted" aria-hidden="true" />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={list}
              aria-activedescendant={shown[active] ? `${list}-${shown[active].id}` : undefined}
              aria-label="Search commands"
              placeholder="Type a command"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={keys}
              className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted/70"
            />
          </div>
          <div
            id={list}
            role="listbox"
            aria-label="Commands"
            className="grid max-h-80 gap-0.5 overflow-y-auto p-1.5"
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
                className="flex cursor-default items-center gap-3 rounded-xl px-3 py-2 text-sm aria-selected:bg-glass-press"
              >
                <span className="grid size-5 place-items-center text-muted">{command.icon}</span>
                <span className="flex-1 truncate">{command.title}</span>
                {command.shortcut && (
                  <kbd className="rounded-md border border-glass-edge px-1.5 py-0.5 font-sans text-[11px] text-muted">
                    {command.shortcut}
                  </kbd>
                )}
              </div>
            ))}
            {shown.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted">No command matches.</p>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

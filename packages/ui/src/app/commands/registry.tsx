'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { type Command, CommandPalette } from '../../kit';

/**
 * A command of the app. `keys` binds it to the system's modifier — ⌘ on macOS, Ctrl elsewhere —
 * with the key named, and shift when asked: the palette shows it, and the window answers to it.
 */
export type AppCommand = Omit<Command, 'shortcut'> & { keys?: { key: string; shift?: boolean } };

type Registry = { register(source: string, commands: AppCommand[]): () => void };

const Context = createContext<Registry | null>(null);

/** Whether the keys are the Mac's: ⌘ for the app's shortcuts, Ctrl elsewhere. */
export const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * Keys a browser keeps for itself — a new window, a tab, closing it, its own settings — and
 * never hands to the page. In a browser their commands stay in the palette without the keys.
 */
const BROWSER_KEEPS = new Set(['n', 't', 'w', ',']);

/**
 * Where each part's commands stand in the list: what is done most first — the agent's chats
 * and places — then the app's, the window's own, and the host's. A part not named comes last.
 */
const ORDER = ['agent', 'app', 'window', 'web'];
const rank = (source: string) => {
  const at = ORDER.indexOf(source);
  return at === -1 ? ORDER.length : at;
};

/** How a binding is written beside the command, the way the system writes its own. */
function shortcutOf(keys: AppCommand['keys']): string | undefined {
  if (!keys) return undefined;
  const key = keys.key.length === 1 ? keys.key.toUpperCase() : keys.key;
  if (isMac()) return `${keys.shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${keys.shift ? 'Shift+' : ''}${key}`;
}

/** Whether a key press is the one a binding names. */
function pressed(event: KeyboardEvent, keys: NonNullable<AppCommand['keys']>): boolean {
  const modifier = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return (
    modifier &&
    !event.altKey &&
    event.shiftKey === Boolean(keys.shift) &&
    event.key.toLowerCase() === keys.key.toLowerCase()
  );
}

/**
 * Holds every command the app's parts offer — the window's, the open gateway's, its agent's —
 * and the palette that lists them, opened with ⌘⇧P (Ctrl+Shift+P elsewhere). `browser` is a
 * host that runs in one, where some keys are the browser's.
 */
export function CommandsProvider({
  children,
  browser = false,
}: {
  children: ReactNode;
  browser?: boolean;
}) {
  const [sources, setSources] = useState<Record<string, AppCommand[]>>({});
  const [open, setOpen] = useState(false);

  const register = useCallback((source: string, commands: AppCommand[]) => {
    setSources((current) => ({ ...current, [source]: commands }));
    return () =>
      setSources((current) => {
        const { [source]: _gone, ...rest } = current;
        return rest;
      });
  }, []);

  const commands = useMemo(
    () =>
      Object.entries(sources)
        .sort(([a], [b]) => rank(a) - rank(b))
        .flatMap(([, listed]) => listed)
        .map((command): AppCommand => {
          if (!browser || !command.keys || command.keys.shift) return command;
          if (!BROWSER_KEEPS.has(command.keys.key)) return command;
          const { keys: _browsers, ...rest } = command;
          return rest;
        }),
    [sources, browser],
  );

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (pressed(event, { key: 'p', shift: true })) {
        event.preventDefault();
        setOpen(true);
        return;
      }
      const command = commands.find((item) => item.keys && pressed(event, item.keys));
      if (!command) return;
      event.preventDefault();
      setOpen(false);
      command.run();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [commands]);

  const listed = useMemo(
    () =>
      commands.map(({ keys, ...command }) => {
        const shortcut = shortcutOf(keys);
        return shortcut ? { ...command, shortcut } : command;
      }),
    [commands],
  );

  return (
    <Context.Provider value={useMemo(() => ({ register }), [register])}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} commands={listed} />
    </Context.Provider>
  );
}

/** Offers `commands` while the caller is mounted; pass a memoized list. */
export function useCommands(source: string, commands: AppCommand[]): void {
  const registry = useContext(Context);
  useEffect(() => registry?.register(source, commands), [registry, source, commands]);
}

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
import {
  type Binding,
  type Bindings,
  bindingId,
  bindingOf,
  readBindings,
  reserved,
  shortcutOf,
} from './keybindings';

export type AppCommand = Omit<Command, 'shortcut'> & { keys?: Binding };
type Registry = { register(source: string, commands: AppCommand[]): () => void };
const Context = createContext<Registry | null>(null);
const SAVED = 'jian-keymaps';
type Keymaps = {
  commands: AppCommand[];
  overrides: Bindings;
  browser: boolean;
  setBinding: (id: string, keys: Binding | null | undefined) => string | undefined;
  reset: () => void;
};
const KeymapsContext = createContext<Keymaps | null>(null);
export const useKeymaps = () => useContext(KeymapsContext);
export { isMac } from './keybindings';

/**
 * Where each part's commands stand in the list: what is done most first — the agent's chats
 * and places — then the app's, the window's own, and the host's. A part not named comes last.
 */
const ORDER = ['agent', 'app', 'window', 'web'];
const rank = (source: string) => {
  const at = ORDER.indexOf(source);
  return at === -1 ? ORDER.length : at;
};

/**
 * Holds every command the app's parts offer — the window's, the open gateway's, its agent's —
 * and the palette that lists them, opened with ⌘⇧P (Ctrl+Shift+P elsewhere). `browser` is a
 * host that runs in one, where some keys are the browser's.
 */
export function CommandsProvider({
  children,
  browser = false,
  onBound,
}: {
  children: ReactNode;
  browser?: boolean;
  /** Told which keys are the app's, for a host with content that takes the keyboard from it. */
  onBound?: (bindings: string[]) => void;
}) {
  const [sources, setSources] = useState<Record<string, AppCommand[]>>({});
  const [open, setOpen] = useState(false);
  const [overrides, setOverrides] = useState<Bindings>({});
  useEffect(() => {
    try {
      setOverrides(readBindings(localStorage.getItem(SAVED)));
    } catch {
      /* Storage is optional. */
    }
  }, []);
  const save = useCallback((next: Bindings) => {
    setOverrides(next);
    try {
      localStorage.setItem(SAVED, JSON.stringify(next));
    } catch {
      /* Keep this visit's choice. */
    }
  }, []);

  const register = useCallback((source: string, commands: AppCommand[]) => {
    setSources((current) => ({ ...current, [source]: commands }));
    return () =>
      setSources((current) => {
        const { [source]: _gone, ...rest } = current;
        return rest;
      });
  }, []);

  const offered = useMemo(
    () => [
      ...Object.entries(sources)
        .sort(([a], [b]) => rank(a) - rank(b))
        .flatMap(([, listed]) => listed),
      {
        id: 'command-palette',
        title: 'Command palette',
        keys: { key: 'p', shift: true },
        run: () => setOpen(true),
      },
    ],
    [sources],
  );

  const commands = useMemo(() => {
    // Explicit choices win over defaults, including defaults offered by a newly opened agent.
    const claimed = new Set<string>();
    const resolved = new Map<string, Binding>();
    const ordered = [...offered].sort(
      (a, b) => Number(Object.hasOwn(overrides, b.id)) - Number(Object.hasOwn(overrides, a.id)),
    );
    for (const command of ordered) {
      const keys = Object.hasOwn(overrides, command.id) ? overrides[command.id] : command.keys;
      if (!keys || reserved(keys, browser) || claimed.has(bindingId(keys))) continue;
      claimed.add(bindingId(keys));
      resolved.set(command.id, keys);
    }
    return offered.map(({ keys: _default, ...command }): AppCommand => {
      const keys = resolved.get(command.id);
      return keys ? { ...command, keys } : command;
    });
  }, [offered, overrides, browser]);

  useEffect(() => {
    onBound?.(commands.flatMap((command) => (command.keys ? [bindingId(command.keys)] : [])));
  }, [commands, onBound]);

  const setBinding = useCallback(
    (id: string, keys: Binding | null | undefined) => {
      const candidate =
        keys === undefined ? offered.find((command) => command.id === id)?.keys : keys;
      if (candidate) {
        if (reserved(candidate, browser))
          return 'This shortcut is reserved by the system or browser.';
        const conflict = commands.find(
          (command) =>
            command.id !== id && command.keys && bindingId(command.keys) === bindingId(candidate),
        );
        if (conflict) return `Already assigned to ${conflict.title}. Clear that shortcut first.`;
      }
      const next = { ...overrides };
      if (keys === undefined) delete next[id];
      else next[id] = keys;
      save(next);
      return undefined;
    },
    [offered, commands, browser, overrides, save],
  );

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      // A recorder or another control may consume a key before app commands see it.
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const binding = bindingOf(event);
      if (!binding) return;
      const command = commands.find(
        (item) => item.keys && bindingId(item.keys) === bindingId(binding),
      );
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
      <KeymapsContext.Provider
        value={useMemo(
          () => ({ commands, overrides, browser, setBinding, reset: () => save({}) }),
          [commands, overrides, browser, setBinding, save],
        )}
      >
        {children}
        <CommandPalette open={open} onOpenChange={setOpen} commands={listed} />
      </KeymapsContext.Provider>
    </Context.Provider>
  );
}

/** Offers `commands` while the caller is mounted; pass a memoized list. */
export function useCommands(source: string, commands: AppCommand[]): void {
  const registry = useContext(Context);
  useEffect(() => registry?.register(source, commands), [registry, source, commands]);
}

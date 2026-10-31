/** App shortcuts use the platform's primary modifier, with optional Shift and Alt. */
export type Binding = { key: string; shift?: boolean; alt?: boolean };
export type Bindings = Record<string, Binding | null>;

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

export function shortcutOf(keys: Binding | undefined): string | undefined {
  if (!keys) return undefined;
  const key = keys.key.toUpperCase();
  return isMac()
    ? `${keys.alt ? '⌥' : ''}${keys.shift ? '⇧' : ''}⌘${key}`
    : `Ctrl+${keys.alt ? 'Alt+' : ''}${keys.shift ? 'Shift+' : ''}${key}`;
}

export function bindingId(keys: Binding): string {
  return `${Boolean(keys.alt)}:${Boolean(keys.shift)}:${keys.key.toLowerCase()}`;
}

const punctuation: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
};

/** Use physical letters with Alt: macOS otherwise reports symbols such as ∆ and dead keys. */
export function bindingOf(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): Binding | undefined {
  const primary = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return undefined;
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3).toLowerCase()
    : /^Digit\d$/.test(event.code)
      ? event.code.slice(5)
      : (punctuation[event.code] ?? event.key.toLowerCase());
  if (key.length !== 1 || /\s/.test(key)) return undefined;
  return { key, shift: event.shiftKey, alt: event.altKey };
}

/** Preserve text editing and native window controls, plus keys blocked by the desktop host. */
export function reserved(keys: Binding, browser: boolean): boolean {
  if (!keys.alt && ['a', 'c', 'v', 'x', 'z', 'q', 'w', 'h', 'm', 'r', '[', ']'].includes(keys.key))
    return true;
  return (
    browser &&
    !keys.alt &&
    ((!keys.shift && ['n', 't', ',', 'l', 'j', 'u', 'd', 'p', 's', 'f'].includes(keys.key)) ||
      (keys.shift === true && ['n', 't', 'b', 'j', 'o', 'delete'].includes(keys.key)))
  );
}

/** Storage is untrusted and may belong to an older version. Invalid entries are ignored. */
export function readBindings(raw: string | null): Bindings {
  try {
    const saved: unknown = JSON.parse(raw ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([, value]) =>
          value === null ||
          (value &&
            typeof value === 'object' &&
            typeof value.key === 'string' &&
            value.key.length === 1 &&
            !/\s/.test(value.key) &&
            value.key === value.key.toLowerCase() &&
            (value.shift === undefined || typeof value.shift === 'boolean') &&
            (value.alt === undefined || typeof value.alt === 'boolean')),
      ),
    );
  } catch {
    return {};
  }
}

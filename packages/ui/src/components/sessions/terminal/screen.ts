import type { FitAddon } from '@xterm/addon-fit';
import type { ITheme, Terminal as XTerm } from '@xterm/xterm';
import { useCrew } from '../../../lib/stores/crew';
import { watchSize } from '../../../lib/watch-size';
import { linkTerminal, type TerminalApi, type TerminalLink, type TerminalSize } from './link';

/** The terminal's letters, in px and as a multiple of their height. */
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.25;
/** What `.terminal-screen .xterm` leaves around the letters, in px: keep the two in step. */
const PADDING = { x: 16, y: 16 };
/** The room xterm keeps for its scrollbar, in px. */
const SCROLLBAR = 14;
const SCROLLBACK_LINES = 5000;
/** The kit's mono face. Its `--font-mono` is Tailwind's name, which the page does not carry. */
const FONT_FAMILY = '"IBM Plex Mono", monospace';

const tokens = () => {
  const style = getComputedStyle(document.documentElement);
  return (name: string) => style.getPropertyValue(name).trim() || undefined;
};

/**
 * The kit's colours as xterm takes them. The ground is clear, so the Inspector's glass shows
 * through as it does behind everything else there; the sixteen colours are in terminal.css.
 */
function palette(): ITheme {
  const token = tokens();
  const colour = (name: string) => token(`--terminal-${name}`);

  return {
    background: 'rgba(0, 0, 0, 0)',
    foreground: token('--ink'),
    cursor: token('--ink'),
    cursorAccent: token('--canvas'),
    selectionBackground: colour('selection'),
    black: colour('black'),
    red: colour('red'),
    green: colour('green'),
    yellow: colour('yellow'),
    blue: colour('blue'),
    magenta: colour('magenta'),
    cyan: colour('cyan'),
    white: colour('white'),
    brightBlack: colour('bright-black'),
    brightRed: colour('red'),
    brightGreen: colour('green'),
    brightYellow: colour('yellow'),
    brightBlue: colour('blue'),
    brightMagenta: colour('magenta'),
    brightCyan: colour('cyan'),
    brightWhite: colour('bright-white'),
  };
}

/**
 * The size a terminal will have in the Inspector's panel, before there is one to measure: a
 * shell started at the size it is then shown at draws its first prompt once, not twice.
 */
export function expectedSize(): TerminalSize {
  const room = document
    .querySelector('[data-inspector-host] [role=tabpanel]')
    ?.getBoundingClientRect();
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT_SIZE}px ${FONT_FAMILY}`;
  probe.textContent = 'W'.repeat(32);
  document.body.append(probe);
  const letters = probe.getBoundingClientRect();
  probe.remove();

  const width = letters.width / 32;
  const height = Math.floor(Math.ceil(letters.height) * LINE_HEIGHT);
  const cols = room && width ? Math.floor((room.width - PADDING.x - SCROLLBAR) / width) : 0;
  const rows = room && height ? Math.floor((room.height - PADDING.y) / height) : 0;

  // Nothing to measure, or no room worth the name: the size every terminal starts from.
  return { cols: cols >= 20 ? cols : 80, rows: rows >= 5 ? rows : 24 };
}

/**
 * The mono face is fetched when something first uses it. A terminal opened before it arrived
 * would measure another face's letters and keep those widths.
 */
const fontReady = () =>
  document.fonts?.load?.(`${FONT_SIZE}px ${FONT_FAMILY}`).catch(() => {}) ?? Promise.resolve();

/** Typing goes to the terminal only when the owner was already in the Inspector, or nowhere. */
const mayTakeFocus = () => {
  const active = document.activeElement;
  return !active || active === document.body || Boolean(active.closest('[data-inspector-host]'));
};

export type TerminalScreen = {
  link: TerminalLink;
  /** Puts the terminal in `container`, sized to it, until the returned function is called. */
  show(container: HTMLElement): () => void;
  /** Its size in letters, once it has been on screen. */
  size(): TerminalSize | undefined;
  dispose(): void;
};

const screens = new Map<string, TerminalScreen>();
const themed = new Set<() => void>();
let themeWatch: MutationObserver | undefined;

function createScreen(api: TerminalApi, profileId: string, terminalId: string): TerminalScreen {
  const element = document.createElement('div');
  element.className = 'terminal-screen';
  let term: XTerm | undefined;
  let fit: FitAddon | undefined;
  /** What the terminal printed before the library that draws it had loaded. */
  let early: string[] = [];
  let disposed = false;
  let fitted = false;

  const link = linkTerminal(api, profileId, terminalId, {
    write: (data) => (term ? term.write(data) : void early.push(data)),
    reset: () => {
      early = [];
      term?.reset();
    },
  });
  const retheme = () => {
    if (term) term.options.theme = palette();
  };
  // Loaded when a terminal is first shown, and in the browser only: the library reads the page
  // as it loads, and most visits never open a terminal.
  const loading = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), fontReady()])
    .then(([xterm, addon]) => {
      if (disposed) return;
      const made = new xterm.Terminal({
        allowTransparency: true,
        cursorBlink: true,
        fontFamily: FONT_FAMILY,
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        scrollback: SCROLLBACK_LINES,
        theme: palette(),
      });
      fit = new addon.FitAddon();
      made.loadAddon(fit);
      made.onData(link.send);
      made.onResize(link.resize);
      // Ctrl+C belongs to the shell, so copying takes Shift as well, as terminals do outside
      // macOS, where Cmd+C is the browser's own and needs nothing here.
      made.attachCustomKeyEventHandler((event) => {
        const copy =
          event.type === 'keydown' &&
          event.code === 'KeyC' &&
          event.ctrlKey &&
          event.shiftKey &&
          !event.altKey &&
          !event.metaKey;
        if (!copy) return true;
        event.preventDefault();
        const text = made.getSelection();
        if (text) void navigator.clipboard?.writeText(text).catch(() => {});
        return false;
      });
      for (const data of early) made.write(data);
      early = [];
      term = made;
      themed.add(retheme);
      themeWatch ??= watchTheme();
    })
    .catch(() => {
      element.textContent = 'The terminal could not be loaded. Reload the panel and open it again.';
    });

  return {
    link,
    show(container) {
      let shown = true;
      const refit = () => {
        if (!shown || !term || !fit || !element.isConnected) return;
        fit.fit();
        fitted = true;
        // Told even when nothing changed here: the shell may have been started at another size.
        link.resize({ cols: term.cols, rows: term.rows });
      };

      container.append(element);
      void loading.then(() => {
        if (!shown || !term) return;
        // Opened where it can be measured: a terminal opened off the page has no letter size.
        if (!term.element) term.open(element);
        refit();
        if (mayTakeFocus()) term.focus();
      });
      const unwatch = watchSize(refit, container);

      return () => {
        shown = false;
        unwatch();
        element.remove();
      };
    },
    size: () => (term && fitted ? { cols: term.cols, rows: term.rows } : undefined),
    dispose() {
      disposed = true;
      link.stop();
      themed.delete(retheme);
      term?.dispose();
      term = undefined;
      element.remove();
      if (!themed.size) {
        themeWatch?.disconnect();
        themeWatch = undefined;
      }
    },
  };
}

/** The panel changes theme by an attribute on the page: every open terminal takes its colours. */
function watchTheme() {
  const watch = new MutationObserver(() => {
    for (const retheme of themed) retheme();
  });
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return watch;
}

/**
 * A terminal's screen and its connection, the same ones for as long as its tab is among those
 * on screen: turning to another tab and back finds it as it was left, with nothing read again.
 */
export function terminalScreen(
  api: TerminalApi,
  profileId: string,
  terminalId: string,
): TerminalScreen {
  let screen = screens.get(terminalId);
  if (!screen) {
    screen = createScreen(api, profileId, terminalId);
    screens.set(terminalId, screen);
  }

  return screen;
}

export const shownTerminal = (terminalId: string) => screens.get(terminalId);

// A tab that left the Inspector, closed or with its conversation, takes its screen with it. The
// shell goes on behind a conversation's saved tab, and what it printed is read again on return.
useCrew.subscribe((state, previous) => {
  if (state.tabs === previous.tabs || !screens.size) return;
  const open = new Set(state.tabs.map((tab) => (tab.kind === 'terminal' ? tab.terminalId : '')));

  for (const [terminalId, screen] of [...screens]) {
    if (open.has(terminalId)) continue;
    screens.delete(terminalId);
    screen.dispose();
  }
});

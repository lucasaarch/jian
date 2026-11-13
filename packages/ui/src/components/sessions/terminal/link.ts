import type { GatewayApi } from '../../../lib/api';
import { GatewayAnswer } from '../../../lib/api/result';

export type TerminalApi = Pick<
  GatewayApi,
  'openTerminal' | 'writeTerminal' | 'resizeTerminal' | 'closeTerminal' | 'terminalOutput'
>;
export type TerminalSize = { cols: number; rows: number };

/** Where a terminal stands, as its tab says it. */
export type TerminalState =
  /** Its stream is being opened for the first time. */
  | { status: 'connecting' }
  | { status: 'open' }
  /** The stream was lost and is being opened again. */
  | { status: 'away' }
  /** The shell ended; the gateway keeps what it printed until the tab is closed. */
  | { status: 'exited'; exitCode: number }
  /** The gateway has no such terminal: it was closed, or the gateway started again. */
  | { status: 'gone' };

/** What a link draws on: the terminal on screen, or anything standing in for it. */
export type TerminalSurface = { write(data: string): void; reset(): void };

/** How long keystrokes gather before they are sent, in ms: a paste or a held key is one request. */
const GATHER_MS = 5;
/** The most one request carries, in characters, which is the gateway's own limit. */
const WRITE_MAX = 65_536;
/** How long a size settles before the shell is told, in ms: dragging a divider tells it once. */
const RESIZE_MS = 120;
/** The wait before a lost stream is opened again, in ms: doubled each time, up to the longest. */
const RETRY_MS = 500;
const RETRY_MAX_MS = 10_000;

const dim = (text: string) => `\r\n\u001b[2m${text}\u001b[0m\r\n`;

/**
 * One terminal's connection to its gateway: what it prints, read from a stream that is opened
 * again when lost, and what is typed, sent in the order it was typed. It knows nothing of the
 * screen but where to write.
 */
export function linkTerminal(
  api: TerminalApi,
  profileId: string,
  terminalId: string,
  surface: TerminalSurface,
) {
  const listeners = new Set<() => void>();
  const stream = new AbortController();
  let state: TerminalState = { status: 'connecting' };
  let stopped = false;
  let typed = '';
  let sending = false;
  let gathering: ReturnType<typeof setTimeout> | undefined;
  let wanted: TerminalSize | undefined;
  let told: TerminalSize | undefined;
  let resizing = false;
  let settling: ReturnType<typeof setTimeout> | undefined;

  const set = (next: TerminalState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const over = () => state.status === 'exited' || state.status === 'gone';

  /**
   * One request at a time, each holding everything typed since the last: two in flight could
   * arrive in either order, and the shell would read the keys out of order.
   */
  async function flush() {
    if (sending) return;
    sending = true;
    try {
      while (typed && !stopped && !over()) {
        let end = Math.min(typed.length, WRITE_MAX);
        // Never half of a character: a pair's first half waits for the next request.
        const last = typed.charCodeAt(end - 1);
        if (end < typed.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        const data = typed.slice(0, end);
        typed = typed.slice(end);
        await api.writeTerminal(profileId, terminalId, data);
      }
    } catch {
      // Whether the gateway read it is unknown, and keys held back would run later, when nobody
      // is looking: what was typed into a failed request is dropped, as on a line that hung up.
      typed = '';
    } finally {
      sending = false;
    }
  }

  /** The latest size wins: the one in flight finishes, then the newest is sent, nothing between. */
  async function tellSize() {
    if (resizing) return;
    resizing = true;
    try {
      while (wanted && !stopped && !over() && !same(wanted, told)) {
        const next = wanted;
        await api.resizeTerminal(profileId, terminalId, next);
        told = next;
      }
    } catch {
      // The next change of size sends it again.
    } finally {
      resizing = false;
    }
  }

  async function read() {
    let wait = RETRY_MS;

    while (!stopped) {
      let exitCode: number | undefined;

      try {
        await api.terminalOutput(
          profileId,
          terminalId,
          {
            // Every stream starts with all the terminal kept: the screen starts over to take it.
            opened: () => {
              surface.reset();
              wait = RETRY_MS;
              set({ status: 'open' });
              // A size chosen while the stream was away never reached the shell.
              void tellSize();
            },
            output: (data) => surface.write(data),
            exit: (code) => {
              exitCode = code;
            },
          },
          stream.signal,
        );
      } catch (error) {
        if (stopped) return;
        if (error instanceof GatewayAnswer && error.status === 404) {
          set({ status: 'gone' });
          return;
        }
      }

      if (stopped) return;
      if (exitCode !== undefined) {
        surface.write(dim(`[Process exited with code ${exitCode}]`));
        set({ status: 'exited', exitCode });
        return;
      }

      // Ended with no exit: the connection dropped, or the gateway cut a reader that fell behind.
      set({ status: 'away' });
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    }
  }

  void read();

  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Keys and pasted text, as the screen gives them. An ended terminal takes none. */
    send(data: string) {
      if (stopped || over()) return;
      typed += data;
      clearTimeout(gathering);
      gathering = setTimeout(() => void flush(), GATHER_MS);
    },
    resize(size: TerminalSize) {
      wanted = {
        cols: Math.max(2, Math.min(1000, Math.round(size.cols))),
        rows: Math.max(1, Math.min(500, Math.round(size.rows))),
      };
      clearTimeout(settling);
      settling = setTimeout(() => void tellSize(), RESIZE_MS);
    },
    /** Stops reading and sending. The terminal itself stays open on the gateway. */
    stop() {
      stopped = true;
      clearTimeout(gathering);
      clearTimeout(settling);
      stream.abort();
      listeners.clear();
    },
  };
}

const same = (a: TerminalSize, b?: TerminalSize) => a.cols === b?.cols && a.rows === b?.rows;

export type TerminalLink = ReturnType<typeof linkTerminal>;

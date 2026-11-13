import { randomUUID } from 'node:crypto';
import {
  TERMINAL_SCROLLBACK,
  TERMINALS_MAX,
  type Terminal,
  terminalSchema,
  type terminalSizeSchema,
} from '@jian/contracts';
import type { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { type PtyProcess, type SpawnPty, spawnPty } from './pty.js';
import type { TerminalStart } from './start.js';

export type TerminalEvent =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  /** The owner closed it, or the gateway is stopping: there is nothing more to wait for. */
  | { type: 'closed' };

type Listener = (event: TerminalEvent) => void;

type Live = {
  profileId: string;
  terminal: Terminal;
  pty: PtyProcess;
  /** The scrollback, as the chunks it arrived in; `kept` is their length in characters. */
  chunks: string[];
  kept: number;
  listeners: Set<Listener>;
};

/** How long a shell has to leave after a hangup before it is killed, in ms. */
const LEAVE_MS = 3000;

/**
 * The terminals the owner has open on this gateway's machine. They live in this process only:
 * a restart ends them all, as closing a terminal window would, and a client that still shows one
 * is told it is gone.
 */
export class Terminals {
  private readonly live = new Map<string, Live>();
  /** Shells being started, which already hold a place under the limit. */
  private opening = 0;

  constructor(
    private readonly spawn: SpawnPty = spawnPty,
    private readonly clock: Clock = Date.now,
  ) {}

  /** A terminal belongs to its profile: another profile's id is not found. */
  private find(profileId: string, terminalId: string): Live {
    const found = this.live.get(terminalId);
    if (!found || found.profileId !== profileId) throw new GatewayError(404, 'Terminal not found');

    return found;
  }

  list(profileId: string): Terminal[] {
    return [...this.live.values()]
      .filter((item) => item.profileId === profileId)
      .map((item) => item.terminal);
  }

  async open(
    profileId: string,
    start: TerminalStart,
    size: z.infer<typeof terminalSizeSchema>,
    sessionId?: string,
  ): Promise<Terminal> {
    // Counted before the first wait, so requests arriving together cannot all pass the limit.
    if (this.live.size + this.opening >= TERMINALS_MAX) {
      throw new GatewayError(
        429,
        `This gateway already has ${TERMINALS_MAX} terminals open. Close one to open another.`,
      );
    }

    this.opening += 1;

    try {
      let pty: PtyProcess;

      try {
        pty = await this.spawn(start.file, start.args, {
          ...size,
          cwd: start.cwd,
          env: start.env,
        });
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError(
          500,
          `The shell ${start.shell} did not start${error instanceof Error ? `: ${error.message}` : ''}`,
        );
      }

      const item: Live = {
        profileId,
        terminal: terminalSchema.parse({
          id: randomUUID(),
          ...(sessionId ? { sessionId } : {}),
          cwd: start.cwd,
          shell: start.shell,
          startedAt: new Date(this.clock()).toISOString(),
        }),
        pty,
        chunks: [],
        kept: 0,
        listeners: new Set(),
      };

      this.live.set(item.terminal.id, item);
      pty.onData((data) => this.keep(item, data));
      pty.onExit(({ exitCode }) => {
        // An ended shell keeps its record, and what it printed, until the owner closes it.
        item.terminal = { ...item.terminal, exitCode };
        this.tell(item, { type: 'exit', exitCode });
      });

      return item.terminal;
    } finally {
      this.opening -= 1;
    }
  }

  private keep(item: Live, data: string) {
    item.chunks.push(data);
    item.kept += data.length;

    // Whole chunks leave from the front while what remains still fills the scrollback, so a
    // busy terminal never copies its whole history for one more line.
    for (
      let oldest = item.chunks[0];
      oldest !== undefined && item.kept - oldest.length >= TERMINAL_SCROLLBACK;
      oldest = item.chunks[0]
    ) {
      item.chunks.shift();
      item.kept -= oldest.length;
    }

    this.tell(item, { type: 'output', data });
  }

  private tell(item: Live, event: TerminalEvent) {
    for (const listener of [...item.listeners]) listener(event);
  }

  /**
   * What the terminal has printed so far, and every event from now on. Both come from the same
   * turn of the loop, so a stream that writes the scrollback at once misses and repeats nothing.
   */
  watch(profileId: string, terminalId: string, listener: Listener) {
    const item = this.find(profileId, terminalId);
    const all = item.chunks.join('');
    let from = Math.max(0, all.length - TERMINAL_SCROLLBACK);
    // Never half of a character: the cut moves past a pair's second half.
    const code = all.charCodeAt(from);
    if (from > 0 && code >= 0xdc00 && code <= 0xdfff) from += 1;

    item.listeners.add(listener);

    return {
      scrollback: all.slice(from),
      exitCode: item.terminal.exitCode,
      stop: () => {
        item.listeners.delete(listener);
      },
    };
  }

  write(profileId: string, terminalId: string, data: string) {
    const item = this.find(profileId, terminalId);
    if (item.terminal.exitCode !== undefined) {
      throw new GatewayError(409, 'This terminal has ended.');
    }

    item.pty.write(data);
  }

  /** A size sent after the shell ended changes nothing, and is not an error either. */
  resize(profileId: string, terminalId: string, size: z.infer<typeof terminalSizeSchema>) {
    const item = this.find(profileId, terminalId);
    if (item.terminal.exitCode !== undefined) return;

    try {
      item.pty.resize(size.cols, size.rows);
    } catch {
      // The shell ended between the check and the call.
    }
  }

  close(profileId: string, terminalId: string) {
    this.end(this.find(profileId, terminalId));
  }

  /** Every shell, when the gateway stops: none may outlive the process that shows it. */
  closeAll() {
    for (const item of [...this.live.values()]) this.end(item);
  }

  private end(item: Live) {
    this.live.delete(item.terminal.id);
    this.tell(item, { type: 'closed' });
    item.listeners.clear();
    if (item.terminal.exitCode !== undefined) return;

    const { pty } = item;
    const signal = (name?: string) => {
      try {
        pty.kill(name);
      } catch {
        // Already gone.
      }
    };

    // A hangup, as closing a terminal window sends: the shell passes it on to its jobs.
    signal();
    // Windows ends the whole console at once and takes no signal.
    if (process.platform === 'win32') return;

    // A shell that ignores the hangup is killed. The timer does not hold the gateway open.
    const kill = setTimeout(() => signal('SIGKILL'), LEAVE_MS);
    kill.unref();
    pty.onExit(() => clearTimeout(kill));
  }
}

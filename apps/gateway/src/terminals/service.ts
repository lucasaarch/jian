import { randomUUID } from 'node:crypto';
import {
  AGENT_PROCESSES_ENDED_KEPT,
  AGENT_PROCESSES_RUNNING_MAX,
  type AgentProcess,
  TERMINAL_SCROLLBACK,
  TERMINALS_MAX,
  type Terminal,
  terminalSchema,
  type terminalSizeSchema,
} from '@jian/contracts';
import type { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { streamMask } from './mask.js';
import { type PtyProcess, type SpawnPty, spawnPty } from './pty.js';
import type { TerminalStart } from './start.js';

export type TerminalEvent =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  /** The owner closed it, or the gateway is stopping: there is nothing more to wait for. */
  | { type: 'closed' };

type Listener = (event: TerminalEvent) => void;

/** What a background command of the agent has beyond a terminal: the owner only watches it. */
type AgentPart = {
  command: string;
  /** Set when it was asked to stop, so its end is told as stopped and not as its own. */
  stopping: boolean;
  /** Counts the ended, to know which are the oldest; absent while it runs. */
  endedAt?: number;
  mask: ReturnType<typeof streamMask>;
};

type Live = {
  profileId: string;
  terminal: Terminal;
  agent?: AgentPart;
  pty: PtyProcess;
  /** The scrollback, as the chunks it arrived in; `kept` is their length in characters. */
  chunks: string[];
  kept: number;
  listeners: Set<Listener>;
};

export type ProcessStart = {
  command: string;
  cwd: string;
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The sensitive values lent to it: masked before anything is kept or shown. */
  secrets: ReadonlySet<string>;
  /** Called with its pid once it runs, for what the caller sets on the process itself. */
  spawned?: (pid: number) => void;
};

/** What the panel is told, so a conversation's badge follows its processes without asking. */
export type ProcessNews = {
  type: 'process.started' | 'process.ended';
  sessionId: string;
  processId: string;
};

/** How long a shell has to leave after a hangup before it is killed, in ms. */
const LEAVE_MS = 3000;
/** Wide, so the terminal itself wraps nothing: a Secret's value is never cut by a line break. */
const PROCESS_COLS = 240;
const PROCESS_ROWS = 50;

/**
 * The terminals the owner has open on this gateway's machine, and the commands the agent runs in
 * the background, which are terminals the owner only watches. They live in this process only:
 * a restart ends them all, as closing a terminal window would, and a client that still shows one
 * is told it is gone.
 */
export class Terminals {
  private readonly live = new Map<string, Live>();
  /** Shells being started, which already hold a place under the limit. */
  private opening = 0;
  /** Background commands being started, per profile, which already hold a place under theirs. */
  private readonly starting = new Map<string, number>();
  private endings = 0;

  constructor(
    private readonly spawn: SpawnPty = spawnPty,
    private readonly clock: Clock = Date.now,
    private readonly announce: (profileId: string, news: ProcessNews) => void = () => {},
  ) {}

  /** A terminal belongs to its profile: another profile's id is not found. */
  private find(profileId: string, terminalId: string): Live {
    const found = this.live.get(terminalId);
    if (!found || found.profileId !== profileId) throw new GatewayError(404, 'Terminal not found');

    return found;
  }

  /** What only the owner's terminal allows: a command of the agent is watched, not typed into. */
  private owned(profileId: string, terminalId: string): Live {
    const item = this.find(profileId, terminalId);
    if (item.agent) {
      throw new GatewayError(409, 'This is a command the agent runs: it can only be watched.');
    }

    return item;
  }

  /** The owner's own: what the agent runs is listed with its conversation, not here. */
  list(profileId: string): Terminal[] {
    return [...this.live.values()]
      .filter((item) => item.profileId === profileId && !item.agent)
      .map((item) => item.terminal);
  }

  async open(
    profileId: string,
    start: TerminalStart,
    size: z.infer<typeof terminalSizeSchema>,
    sessionId?: string,
  ): Promise<Terminal> {
    // Counted before the first wait, so requests arriving together cannot all pass the limit.
    // The agent's commands have a limit of their own and take nothing from the owner's.
    const mine = [...this.live.values()].filter((item) => !item.agent).length;
    if (mine + this.opening >= TERMINALS_MAX) {
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
    const item = this.owned(profileId, terminalId);
    if (item.terminal.exitCode !== undefined) {
      throw new GatewayError(409, 'This terminal has ended.');
    }

    item.pty.write(data);
  }

  /** A size sent after the shell ended changes nothing, and is not an error either. */
  resize(profileId: string, terminalId: string, size: z.infer<typeof terminalSizeSchema>) {
    const item = this.owned(profileId, terminalId);
    if (item.terminal.exitCode !== undefined) return;

    try {
      item.pty.resize(size.cols, size.rows);
    } catch {
      // The shell ended between the check and the call.
    }
  }

  close(profileId: string, terminalId: string) {
    this.end(this.owned(profileId, terminalId));
  }

  /**
   * Every shell and every background command, when the gateway stops: none may outlive the
   * process that shows it. Resolves once the commands have left, or been killed.
   */
  async closeAll() {
    const leaving: Promise<void>[] = [];

    for (const item of [...this.live.values()]) {
      if (item.agent) leaving.push(this.forget(item));
      else this.end(item);
    }

    await Promise.all(leaving);
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

  // The agent's background commands: terminals the owner watches and the agent reads and stops.

  private describe(item: Live): AgentProcess {
    const { terminal, agent } = item;
    const exitCode = terminal.exitCode;

    return {
      id: terminal.id,
      sessionId: terminal.sessionId ?? '',
      command: agent?.command ?? '',
      cwd: terminal.cwd,
      startedAt: terminal.startedAt,
      status: exitCode === undefined ? 'running' : agent?.stopping ? 'stopped' : 'exited',
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }

  /** A command belongs to its profile, as a terminal does: another profile's id is not found. */
  private found(profileId: string, processId: string, sessionId?: string): Live {
    const item = this.live.get(processId);
    if (
      !item?.agent ||
      item.profileId !== profileId ||
      (sessionId !== undefined && item.terminal.sessionId !== sessionId)
    ) {
      throw new GatewayError(404, 'Process not found');
    }

    return item;
  }

  /** The profile's commands, oldest first; of one conversation when it is named. */
  processes(profileId: string, sessionId?: string): AgentProcess[] {
    return [...this.live.values()]
      .filter(
        (item) =>
          item.agent &&
          item.profileId === profileId &&
          (sessionId === undefined || item.terminal.sessionId === sessionId),
      )
      .map((item) => this.describe(item));
  }

  /** What it has printed, already masked: the same text the owner's stream shows. */
  processOutput(profileId: string, processId: string) {
    const item = this.found(profileId, processId);

    return { process: this.describe(item), output: item.chunks.join('') };
  }

  async startProcess(
    profileId: string,
    sessionId: string,
    start: ProcessStart,
  ): Promise<AgentProcess> {
    const running = this.processes(profileId).filter((item) => item.status === 'running').length;
    const starting = this.starting.get(profileId) ?? 0;
    // Counted before the first wait, so commands started together cannot all pass the limit.
    if (running + starting >= AGENT_PROCESSES_RUNNING_MAX) {
      throw new GatewayError(
        429,
        `${AGENT_PROCESSES_RUNNING_MAX} commands of yours are already running in the background. Stop one before starting another.`,
      );
    }

    this.starting.set(profileId, starting + 1);

    try {
      let pty: PtyProcess;

      try {
        pty = await this.spawn(start.file, start.args, {
          cols: PROCESS_COLS,
          rows: PROCESS_ROWS,
          cwd: start.cwd,
          env: start.env,
        });
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError(
          500,
          `The command did not start${error instanceof Error ? `: ${error.message}` : ''}`,
        );
      }

      const agent: AgentPart = {
        command: start.command,
        stopping: false,
        mask: streamMask(start.secrets),
      };
      const item: Live = {
        profileId,
        agent,
        terminal: terminalSchema.parse({
          id: randomUUID(),
          sessionId,
          cwd: start.cwd,
          shell: '/bin/sh',
          startedAt: new Date(this.clock()).toISOString(),
        }),
        pty,
        chunks: [],
        kept: 0,
        listeners: new Set(),
      };

      this.live.set(item.terminal.id, item);
      start.spawned?.(pty.pid);
      // Masked before it is kept: the scrollback is all the owner's stream, the paired phone and
      // the agent ever read.
      pty.onData((data) => {
        const shown = agent.mask.push(data);
        if (shown) this.keep(item, shown);
      });
      pty.onExit(({ exitCode, signal }) => {
        const rest = agent.mask.end();
        if (rest) this.keep(item, rest);
        // A command a signal ended has no code of its own: the shell's way of saying it.
        const code = signal ? 128 + signal : exitCode;
        item.terminal = { ...item.terminal, exitCode: code };
        this.endings += 1;
        agent.endedAt = this.endings;
        this.tell(item, { type: 'exit', exitCode: code });
        this.announce(profileId, { type: 'process.ended', sessionId, processId: item.terminal.id });
        this.prune(profileId);
      });
      this.announce(profileId, { type: 'process.started', sessionId, processId: item.terminal.id });

      return this.describe(item);
    } finally {
      this.starting.set(profileId, (this.starting.get(profileId) ?? 1) - 1);
    }
  }

  /** The oldest ended commands go once a profile holds more than it keeps. */
  private prune(profileId: string) {
    const ended = [...this.live.values()]
      .filter((item) => item.profileId === profileId && item.agent?.endedAt !== undefined)
      .sort((a, b) => (a.agent?.endedAt ?? 0) - (b.agent?.endedAt ?? 0));

    for (const item of ended.slice(0, Math.max(0, ended.length - AGENT_PROCESSES_ENDED_KEPT))) {
      this.live.delete(item.terminal.id);
      this.tell(item, { type: 'closed' });
      item.listeners.clear();
    }
  }

  /**
   * A signal to the command and what it started: the shell leads its own process group, so one
   * signal to the group reaches a `sleep 1000 &` it left behind, which a hangup to the shell
   * alone would not.
   */
  private signalGroup(item: Live, name: string) {
    const { pid } = item.pty;

    if (process.platform !== 'win32' && pid > 1) {
      try {
        process.kill(-pid, name);
        return;
      } catch {
        // The group is gone, or was never one: fall back to the shell itself.
      }
    }

    try {
      item.pty.kill(name);
    } catch {
      // Already gone.
    }
  }

  /**
   * Asks it to end and waits until it has: a termination first, a kill of the whole group after
   * `LEAVE_MS`. The kill is sent even when the shell left sooner, for what it started and that
   * ignored the first signal.
   */
  private leave(item: Live): Promise<void> {
    const { agent } = item;
    if (!agent || item.terminal.exitCode !== undefined) return Promise.resolve();

    agent.stopping = true;
    this.signalGroup(item, 'SIGTERM');
    const kill = setTimeout(() => this.signalGroup(item, 'SIGKILL'), LEAVE_MS);
    kill.unref();

    return new Promise((resolve) => {
      // If nothing reports the end, the wait still ends: a reply must not hang on a command.
      const give = setTimeout(done, LEAVE_MS + 500);
      give.unref();
      const listener: Listener = (event) => {
        if (event.type !== 'output') done();
      };

      function done() {
        clearTimeout(give);
        item.listeners.delete(listener);
        resolve();
      }

      item.listeners.add(listener);
    });
  }

  /** Stops one of the profile's commands, which keeps its record and what it printed. */
  async stopProcess(profileId: string, processId: string, sessionId?: string) {
    const item = this.found(profileId, processId, sessionId);
    await this.leave(item);

    return this.describe(item);
  }

  /** The command ends, and its record and output go with it. */
  private async forget(item: Live) {
    await this.leave(item);
    this.live.delete(item.terminal.id);
    this.tell(item, { type: 'closed' });
    item.listeners.clear();
  }

  /** A conversation was deleted: what it ran ends with it. */
  async forgetSession(profileId: string, sessionId: string) {
    await Promise.all(
      [...this.live.values()]
        .filter(
          (item) =>
            item.agent && item.profileId === profileId && item.terminal.sessionId === sessionId,
        )
        .map((item) => this.forget(item)),
    );
  }

  /** A profile was deleted: nothing it ran stays. */
  async forgetProfile(profileId: string) {
    await Promise.all(
      [...this.live.values()]
        .filter((item) => item.agent && item.profileId === profileId)
        .map((item) => this.forget(item)),
    );
  }
}

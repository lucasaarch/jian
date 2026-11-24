import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  FORWARD_CONNECTIONS_MAX,
  FORWARD_IDLE_MS,
  FORWARDS_PER_PROFILE,
  type Forward,
  type ForwardAssignment,
  type ForwardStateInput,
  REMOTE_BROWSER_CAPABILITY,
  REMOTE_FORWARDS_CAPABILITY,
} from '@jian/contracts';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { Remote } from '../remote/service.js';
import type { Store } from '../storage/database.js';
import { connectLoopback } from './loopback.js';

/** How long `create` waits for the machine's worker to open the port, in ms. */
const OPEN_WAIT_MS = 10_000;
/** How often connections are checked for silence, in ms. */
const SWEEP_MS = 30_000;

type Live = {
  profileId: string;
  forward: Forward;
  /** Open connections to the server's port, by id. A connection belongs to one machine's worker. */
  connections: Map<string, { socket: Socket; bytes: number; activeAt: number }>;
};

type Machines = Pick<Remote, 'list' | 'authenticate'>;

/**
 * Ports of this server that connected computers reach on their own `localhost`. The state lives
 * in this process only: a restart ends every forward, and a worker that no longer is told of one
 * closes its listener. Only the gateway process that serves HTTP holds it, which is why the tool
 * is offered where the API and the runs share a process.
 *
 * The tunnel is plain HTTP so it crosses the web server's proxy, which carries no WebSocket: the
 * worker opens a connection (POST), reads what the server sends from a stream (GET), writes
 * what the computer sends (POST per chunk) and closes (DELETE). The gateway reaches only the
 * loopback of the machine it runs on.
 */
export class Forwards {
  private readonly live = new Map<string, Live>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: Store,
    private readonly machines: Machines,
    private readonly clock: Clock = Date.now,
    private readonly openWaitMs = OPEN_WAIT_MS,
  ) {}

  /** The forwards of one conversation of a profile. */
  list(profileId: string, sessionId: string): Forward[] {
    return [...this.live.values()]
      .filter((entry) => entry.profileId === profileId && entry.forward.sessionId === sessionId)
      .map((entry) => entry.forward)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** What a machine's worker is told to keep open. */
  assigned(machineId: string): ForwardAssignment[] {
    return [...this.live.values()]
      .filter((entry) => entry.forward.machineId === machineId)
      .map((entry) => ({ id: entry.forward.id, port: entry.forward.remotePort }));
  }

  /**
   * Opens a port of this server on a connected computer and waits a few seconds for its worker.
   * Without `machine`, it is the one desktop app that is online; `machine` is an id or a name.
   * Asking again for a port already forwarded in the conversation returns that forward.
   */
  async create(
    run: { profileId: string; sessionId: string },
    input: { port: number; machine?: string | undefined },
  ): Promise<Forward> {
    const machine = await this.machine(input.machine);
    const same = [...this.live.values()].find(
      (entry) =>
        entry.profileId === run.profileId &&
        entry.forward.sessionId === run.sessionId &&
        entry.forward.machineId === machine.id &&
        entry.forward.remotePort === input.port &&
        entry.forward.status !== 'failed',
    );
    // A port that failed is asked for again to try again: the failed one gives way.
    for (const [id, entry] of this.live) {
      if (
        entry.forward.status === 'failed' &&
        entry.profileId === run.profileId &&
        entry.forward.sessionId === run.sessionId &&
        entry.forward.machineId === machine.id &&
        entry.forward.remotePort === input.port
      ) {
        this.live.delete(id);
        await this.changed(entry);
      }
    }
    const mine = [...this.live.values()].filter((entry) => entry.profileId === run.profileId);
    if (!same && mine.length >= FORWARDS_PER_PROFILE) {
      throw new GatewayError(
        409,
        `At most ${FORWARDS_PER_PROFILE} ports can be forwarded at once. Stop one first.`,
      );
    }

    const entry =
      same ??
      this.add({
        profileId: run.profileId,
        forward: {
          id: randomUUID(),
          sessionId: run.sessionId,
          machineId: machine.id,
          machineName: machine.name,
          remotePort: input.port,
          status: 'waiting',
          createdAt: new Date(this.clock()).toISOString(),
        },
        connections: new Map(),
      });
    await this.changed(entry);

    const deadline = Date.now() + this.openWaitMs;
    while (entry.forward.status === 'waiting' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return entry.forward;
  }

  /** The owner stops it: its connections close and its machine is told to drop the port. */
  async close(profileId: string, forwardId: string): Promise<void> {
    const entry = this.live.get(forwardId);
    if (!entry || entry.profileId !== profileId) throw new GatewayError(404, 'Forward not found');
    this.live.delete(forwardId);
    for (const { socket } of entry.connections.values()) socket.destroy();
    entry.connections.clear();
    await this.changed(entry);
  }

  /** The agent stops forwarding a port of this conversation; how many were stopped. */
  async closePort(run: { profileId: string; sessionId: string }, port: number): Promise<number> {
    const ids = this.list(run.profileId, run.sessionId)
      .filter((forward) => forward.remotePort === port)
      .map((forward) => forward.id);
    for (const id of ids) await this.close(run.profileId, id);
    return ids.length;
  }

  /** The machine's worker says whether it opened the port, and which one. */
  async report(
    machineId: string,
    authorization: string,
    forwardId: string,
    state: ForwardStateInput,
  ): Promise<void> {
    const entry = await this.owned(machineId, authorization, forwardId);
    const { forward } = entry;
    const { localPort: _localPort, error: _error, ...rest } = forward;
    entry.forward =
      state.status === 'open'
        ? { ...rest, status: 'open', localPort: state.localPort }
        : { ...rest, status: 'failed', error: state.error };
    // A listener that moved to another port leaves the connections of the old one to end.
    if (state.status === 'failed' || forward.localPort !== state.localPort) {
      for (const { socket } of entry.connections.values()) socket.destroy();
    }
    await this.changed(entry);
  }

  /** A connection to the server's port for one the computer accepted. */
  async open(machineId: string, authorization: string, forwardId: string): Promise<string> {
    const entry = await this.owned(machineId, authorization, forwardId);
    if (entry.connections.size >= FORWARD_CONNECTIONS_MAX) {
      throw new GatewayError(429, `At most ${FORWARD_CONNECTIONS_MAX} connections at once.`);
    }
    const socket = await connectLoopback(entry.forward.remotePort).catch(() => {
      throw new GatewayError(
        502,
        `Nothing is listening on port ${entry.forward.remotePort} of the server.`,
      );
    });
    const id = randomUUID();
    entry.connections.set(id, { socket, bytes: 0, activeAt: this.clock() });
    socket.once('close', () => entry.connections.delete(id));
    this.startSweeping();
    return id;
  }

  /** The socket of a connection, for the stream that carries what the server sends. */
  async socket(
    machineId: string,
    authorization: string,
    forwardId: string,
    connectionId: string,
  ): Promise<Socket> {
    return (await this.connection(machineId, authorization, forwardId, connectionId)).socket;
  }

  /** What the computer sent, written to the server's socket; waits while it is slow to take it. */
  async write(
    machineId: string,
    authorization: string,
    forwardId: string,
    connectionId: string,
    bytes: Buffer,
  ): Promise<void> {
    const { socket } = await this.connection(machineId, authorization, forwardId, connectionId);
    if (socket.destroyed || !socket.writable) throw new GatewayError(410, 'Connection closed');
    if (socket.write(bytes)) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        socket.off('drain', done);
        socket.off('close', done);
        if (socket.destroyed) reject(new GatewayError(410, 'Connection closed'));
        else resolve();
      };
      socket.once('drain', done);
      socket.once('close', done);
    });
  }

  async closeConnection(
    machineId: string,
    authorization: string,
    forwardId: string,
    connectionId: string,
  ): Promise<void> {
    const { socket } = await this.connection(machineId, authorization, forwardId, connectionId);
    socket.destroy();
  }

  /** Ends every forward: the gateway is stopping. */
  stop(): void {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const entry of this.live.values()) {
      for (const { socket } of entry.connections.values()) socket.destroy();
    }
    this.live.clear();
  }

  private add(entry: Live): Live {
    this.live.set(entry.forward.id, entry);
    return entry;
  }

  /** The machine to forward to, among those that are online and can do it. */
  private async machine(named: string | undefined) {
    const machines = await this.machines.list();
    const wanted = named?.trim().toLowerCase();
    const found = wanted
      ? machines.filter((machine) => machine.id === wanted || machine.name.toLowerCase() === wanted)
      : machines.filter(
          (machine) => machine.online && machine.capabilities.includes(REMOTE_BROWSER_CAPABILITY),
        );
    if (wanted && found.length !== 1) {
      throw new GatewayError(
        found.length ? 400 : 404,
        found.length
          ? 'More than one machine has that name: give its id as machine.'
          : 'No machine has that name or id: list_remote_machines shows them.',
      );
    }
    if (found.length > 1) {
      throw new GatewayError(
        409,
        'More than one computer runs the Jian app: name the one to forward to as machine.',
      );
    }
    const machine = found[0];
    if (!machine) {
      throw new GatewayError(
        409,
        'No computer running the Jian app is online. Open the app on the computer, or give the machine to forward to.',
      );
    }
    if (!machine.online) throw new GatewayError(503, `${machine.name} is offline`);
    if (machine.outdated) {
      throw new GatewayError(
        409,
        `${machine.name} runs a release that does not match this gateway: update the desktop app or Jian Remote on it.`,
      );
    }
    if (!machine.capabilities.includes(REMOTE_FORWARDS_CAPABILITY)) {
      throw new GatewayError(
        409,
        `${machine.name} cannot forward ports yet: update the desktop app or Jian Remote on it.`,
      );
    }
    return machine;
  }

  /** A forward of the machine that proves it is this one: any other id is not found. */
  private async owned(machineId: string, authorization: string, forwardId: string) {
    const machine = await this.machines.authenticate(machineId, authorization);
    const entry = this.live.get(forwardId);
    if (!entry || entry.forward.machineId !== machine.id) {
      throw new GatewayError(404, 'Forward not found');
    }
    return entry;
  }

  private async connection(
    machineId: string,
    authorization: string,
    forwardId: string,
    connectionId: string,
  ) {
    const entry = await this.owned(machineId, authorization, forwardId);
    const connection = entry.connections.get(connectionId);
    if (!connection) throw new GatewayError(404, 'Connection not found');
    return connection;
  }

  /** Tells the panels, which follow the profile's events, that a forward opened, moved or ended. */
  private async changed(entry: Live) {
    await recordEvent(this.store.db, this.clock, entry.profileId, 'forward.changed', {
      sessionId: entry.forward.sessionId,
      forwardId: entry.forward.id,
    }).catch(() => {});
  }

  private startSweeping() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  /** Closes the connections that carried no byte either way for FORWARD_IDLE_MS. */
  sweep(): void {
    const now = this.clock();
    for (const { connections } of this.live.values()) {
      for (const connection of connections.values()) {
        const bytes = connection.socket.bytesRead + connection.socket.bytesWritten;
        if (bytes !== connection.bytes) {
          connection.bytes = bytes;
          connection.activeAt = now;
        } else if (now - connection.activeAt > FORWARD_IDLE_MS) {
          connection.socket.destroy();
        }
      }
    }
  }
}

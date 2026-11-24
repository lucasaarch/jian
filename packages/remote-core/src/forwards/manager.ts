import { createServer, type Server, type Socket } from 'node:net';
import type { Logger } from '../log.ts';
import { CHUNK_MAX, LOCAL_PORTS } from './limits.ts';
import { frames } from './sse.ts';

export type ForwardAssignment = { id: string; port: number };

type Options = {
  /** `${gateway}/v1/remote/worker/${machineId}` */
  base: string;
  headers: () => Record<string, string>;
  log: Logger;
};

type Listener = {
  server: Server;
  sockets: Set<Socket>;
  /** Set once the gateway knows the port, so a failed report is told again on the next poll. */
  reported: boolean;
  localPort?: number;
  error?: string;
  closed: boolean;
};

/** The ports of the range in random order, so two forwards rarely contend and none is guessable. */
function shuffledPorts(): number[] {
  const ports: number[] = [];
  for (let port = LOCAL_PORTS.first; port <= LOCAL_PORTS.last; port += 1) ports.push(port);
  for (let i = ports.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [ports[i], ports[j]] = [ports[j] as number, ports[i] as number];
  }
  return ports;
}

/** Listens on 127.0.0.1 only: never on an address another computer on the network can reach. */
async function listenFree(server: Server): Promise<number> {
  for (const port of shuffledPorts()) {
    const bound = await new Promise<boolean | Error>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) =>
        resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES' ? false : error);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(true);
      });
    });
    if (bound === true) return port;
    if (bound instanceof Error) throw bound;
  }
  throw new Error(`No free port between ${LOCAL_PORTS.first} and ${LOCAL_PORTS.last}.`);
}

/**
 * The forwards a gateway assigns to this machine: one listener on 127.0.0.1 for each, whose
 * connections are carried to the gateway as plain HTTP (open with a POST, read the stream of
 * what the server sends, post what the computer sends, close with a DELETE). `sync` is called
 * with the assignments of each poll and brings the listeners to match it.
 */
export function createForwards({ base, headers, log }: Options) {
  const listeners = new Map<string, Listener>();

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/forwards/${path}`, {
      ...init,
      headers: { ...headers(), ...(init.body ? { 'content-type': 'application/json' } : {}) },
      redirect: 'error',
    });

  function drop(id: string) {
    const listener = listeners.get(id);
    if (!listener) return;
    listeners.delete(id);
    listener.closed = true;
    listener.server.close();
    for (const socket of listener.sockets) socket.destroy();
  }

  async function report(id: string, listener: Listener) {
    const body =
      listener.localPort !== undefined
        ? { status: 'open', localPort: listener.localPort }
        : { status: 'failed', error: listener.error ?? 'Could not open a local port.' };
    try {
      const response = await call(`${id}/state`, { method: 'POST', body: JSON.stringify(body) });
      if (response.status === 404) return drop(id);
      listener.reported = response.ok;
    } catch {
      // The next poll tells it again.
    }
  }

  async function start(id: string, port: number) {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true });
    const listener: Listener = { server, sockets: new Set(), reported: false, closed: false };
    listeners.set(id, listener);
    server.on('connection', (socket) => {
      if (listener.closed) return socket.destroy();
      listener.sockets.add(socket);
      socket.once('close', () => listener.sockets.delete(socket));
      void carry(id, socket);
    });
    server.on('error', () => {});
    try {
      listener.localPort = await listenFree(server);
      log.info('Forward opened', { port, localPort: listener.localPort });
    } catch (error) {
      listener.error = error instanceof Error ? error.message : String(error);
      log.warn('Forward failed', { port, error: listener.error });
    }
    if (!listener.closed) await report(id, listener);
  }

  /** One accepted connection, until either side ends it. */
  async function carry(id: string, socket: Socket) {
    socket.on('error', () => {});
    let connection: string;
    try {
      const response = await call(`${id}/connections`, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      connection = ((await response.json()) as { id: string }).id;
    } catch (error) {
      log.warn('Forward connection refused', {
        error: error instanceof Error ? error.message : String(error),
      });
      return socket.destroy();
    }
    const path = `${id}/connections/${connection}`;
    const abort = new AbortController();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      abort.abort();
      socket.destroy();
      void call(path, { method: 'DELETE' }).catch(() => {});
    };
    socket.once('close', close);

    // From the server to the computer.
    void (async () => {
      try {
        const response = await call(`${path}/stream`, { signal: abort.signal });
        if (!response.ok || !response.body) return close();
        for await (const frame of frames(response.body)) {
          if (closed) return;
          if (frame.event === 'end') return close();
          if (frame.event !== 'data') continue;
          const { data } = JSON.parse(frame.data) as { data: string };
          if (!socket.write(Buffer.from(data, 'base64'))) {
            await new Promise<void>((resolve) => {
              socket.once('drain', resolve);
              socket.once('close', resolve);
            });
          }
        }
      } catch {
        // An aborted stream is the connection closing.
      }
      close();
    })();

    // From the computer to the server, in order, one request at a time.
    let pending: Buffer[] = [];
    let size = 0;
    let pumping = false;
    let ended = false;
    const pump = async () => {
      if (pumping) return;
      pumping = true;
      try {
        while (pending.length && !closed) {
          const all = Buffer.concat(pending);
          const chunk = all.subarray(0, CHUNK_MAX);
          const rest = all.subarray(CHUNK_MAX);
          pending = rest.length ? [rest] : [];
          size = rest.length;
          const response = await call(`${path}/data`, {
            method: 'POST',
            body: JSON.stringify({ data: chunk.toString('base64') }),
            signal: abort.signal,
          });
          if (!response.ok) return close();
        }
      } catch {
        return close();
      } finally {
        pumping = false;
      }
      if (ended) return close();
      if (!closed) socket.resume();
    };
    socket.on('data', (chunk: Buffer) => {
      pending.push(chunk);
      size += chunk.length;
      // A server slower than the computer pauses the socket instead of filling memory.
      if (size >= CHUNK_MAX) socket.pause();
      void pump();
    });
    // Half-closing is not carried: once what was sent is delivered, the connection ends.
    socket.on('end', () => {
      ended = true;
      void pump();
    });
    socket.resume();
  }

  return {
    /** Brings the listeners to the assignments: opens new ones, tells a failed report again. */
    sync(assignments: ForwardAssignment[]) {
      const wanted = new Set(assignments.map((assignment) => assignment.id));
      for (const id of [...listeners.keys()]) if (!wanted.has(id)) drop(id);
      for (const { id, port } of assignments) {
        const listener = listeners.get(id);
        if (!listener) void start(id, port);
        else if (!listener.reported && (listener.localPort || listener.error)) {
          void report(id, listener);
        }
      }
    },
    stop() {
      for (const id of [...listeners.keys()]) drop(id);
    },
  };
}

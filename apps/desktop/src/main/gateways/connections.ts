import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { app, session } from 'electron';
import { closeMonitorConnections } from './fetch';

/** Past this size the log moves aside to connections.old.log and starts over: two files at most. */
const KEEP_BYTES = 2 * 1024 * 1024;
/** Stalled requests to one gateway, within `STALL_WINDOW_MS`, that close the window's connections. */
const STALLS = 2;
const STALL_WINDOW_MS = 2 * 60_000;
/** The least time between two closings for stalls, in ms: new connections need time to prove. */
const CLOSE_EVERY_MS = 30_000;

let size: number | undefined;
let writing = Promise.resolve();

/**
 * What the window's connections to the gateways went through: event streams opened and ended,
 * requests that failed or got nothing back, and every time the app closed its connections. In the
 * app's log folder beside the others, for the owner to send when the app falls out of step with
 * a gateway. Never a token, a header or a query.
 */
export function logConnections(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  writing = writing.then(() => write(line)).catch(() => {});
}

async function write(line: string): Promise<void> {
  const dir = app.getPath('logs');
  const path = join(dir, 'connections.log');
  if (size === undefined) {
    await mkdir(dir, { recursive: true });
    size = await stat(path).then(
      (file) => file.size,
      () => 0,
    );
  }
  if (size > KEEP_BYTES) {
    await rename(path, join(dir, 'connections.old.log')).catch(() => {});
    size = 0;
  }
  await appendFile(path, line, { mode: 0o600 });
  size += Buffer.byteLength(line);
}

/**
 * Closes every connection of the window and of the gateway monitor. Their event streams fail and
 * reopen on new ones, resuming where they were; a look of the monitor cut off by it is not taken
 * for the gateway's answer. The monitor's session also carries the machine registry's and a new
 * gateway's checks: one of those under way is cut too, and fails as a dropped request.
 */
export async function closeConnections(why: string): Promise<void> {
  logConnections(`Closing every connection: ${why}`);
  await Promise.allSettled([
    session.defaultSession.closeAllConnections(),
    closeMonitorConnections(),
  ]);
}

const stalls = new Map<string, number[]>();
let closedAt = 0;

/**
 * A request to a gateway that got nothing back in time: no answer, or an answer that stopped
 * moving. Every request of the window to a host shares one HTTP/2 connection, which can stop
 * carrying anything without failing, after a network change or a sleep, and then no request
 * gets through until it is closed: reloading the window does not close it, nor does hiding it.
 * A second stall within a short while closes the window's connections, as Reconnect would.
 */
export function stalled(gateway: string, what: string): void {
  const now = Date.now();
  const recent = [...(stalls.get(gateway) ?? []), now].filter((at) => now - at < STALL_WINDOW_MS);
  stalls.set(gateway, recent);
  logConnections(`${gateway} ${what}`);
  if (recent.length < STALLS || now - closedAt < CLOSE_EVERY_MS) return;
  closedAt = now;
  stalls.clear();
  logConnections(
    `Closing the window's connections: ${recent.length} requests to ${gateway} stalled`,
  );
  void session.defaultSession.closeAllConnections().catch(() => {});
}

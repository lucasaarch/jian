import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  logs: '',
  windowClosed: vi.fn(async () => undefined),
}));
const monitorClosed = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('electron', () => ({
  app: { getPath: () => electron.logs },
  session: { defaultSession: { closeAllConnections: electron.windowClosed } },
}));
vi.mock('./fetch', () => ({ closeMonitorConnections: monitorClosed }));

const fresh = async () => {
  vi.resetModules();
  return import('./connections');
};

beforeEach(async () => {
  electron.logs = await mkdtemp(join(tmpdir(), 'jian-connections-'));
  electron.windowClosed.mockClear();
  monitorClosed.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(electron.logs, { recursive: true, force: true });
});

const log = () => readFile(join(electron.logs, 'connections.log'), 'utf8').catch(() => '');
/** Waits for the log to say `line` last: writes go on after a test ends, into the next one's. */
const logged = (line: string) =>
  vi.waitFor(async () => expect((await log()).trimEnd().endsWith(line)).toBe(true));

it('closes the window’s connections on a second stall of one gateway, not on the first', async () => {
  const { stalled } = await fresh();

  stalled('harbor.example.test', 'GET /v1/sessions got no answer in 60s');
  expect(electron.windowClosed).not.toHaveBeenCalled();

  vi.setSystemTime(new Date('2026-01-10T12:01:00Z'));
  stalled('harbor.example.test', 'GET /v1/events went silent, open for 300s');
  expect(electron.windowClosed).toHaveBeenCalledOnce();
  // The monitor's own connections are left alone: it answered, or it would have said so.
  expect(monitorClosed).not.toHaveBeenCalled();

  await logged('2 requests to harbor.example.test stalled');
});

it('does not count stalls far apart, nor those of different gateways, together', async () => {
  const { stalled } = await fresh();

  stalled('harbor.example.test', 'first');
  stalled('quay.example.test', 'first');
  vi.setSystemTime(new Date('2026-01-10T12:03:00Z'));
  stalled('harbor.example.test', 'second, minutes later');

  expect(electron.windowClosed).not.toHaveBeenCalled();
  await logged('second, minutes later');
});

it('gives fresh connections time to prove themselves before closing them again', async () => {
  const { stalled } = await fresh();

  stalled('harbor.example.test', 'one');
  stalled('harbor.example.test', 'two');
  expect(electron.windowClosed).toHaveBeenCalledOnce();

  vi.setSystemTime(new Date('2026-01-10T12:00:10Z'));
  stalled('harbor.example.test', 'three');
  stalled('harbor.example.test', 'four');
  expect(electron.windowClosed).toHaveBeenCalledOnce();

  vi.setSystemTime(new Date('2026-01-10T12:00:40Z'));
  stalled('harbor.example.test', 'five');
  expect(electron.windowClosed).toHaveBeenCalledTimes(2);
  await logged('3 requests to harbor.example.test stalled');
});

it('closes the window’s and the monitor’s connections when asked, and says why', async () => {
  const { closeConnections } = await fresh();

  await closeConnections('Reconnect asked for https://harbor.example.test');

  expect(electron.windowClosed).toHaveBeenCalledOnce();
  expect(monitorClosed).toHaveBeenCalledOnce();
  await logged('harbor.example.test');
  expect(await log()).toMatch(
    /^2026-01-10T12:00:00\.000Z Closing every connection: Reconnect asked for https:\/\/harbor\.example\.test\n$/,
  );
});

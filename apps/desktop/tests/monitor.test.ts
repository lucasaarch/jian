import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notice } from '../src/main/gateways/monitor';
import type { ListedSession, OpenRun } from '../src/main/gateways/news';

/** A gateway in memory: what its lists say now, and whether an agent's list fails. */
const gateway = vi.hoisted(() => ({
  sessions: [] as ListedSession[],
  runs: [] as OpenRun[],
  failing: false,
  /** Holds every sessions request until released, to overlap two looks. */
  hold: undefined as Promise<void> | undefined,
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

vi.mock('../src/main/gateways/fetch', () => ({
  timedFetch: () => async (input: Request) => {
    const path = new URL(input.url).pathname;
    if (path === '/health') return json({ status: 'ok', version: '1.1.3' });
    if (path === '/v1/profiles') return json([{ id: 'agent-1', name: 'Ada' }]);
    if (path.endsWith('/sessions')) {
      await gateway.hold;
      return gateway.failing ? json({ error: 'busy' }, 503) : json(gateway.sessions);
    }
    if (path.endsWith('/activities')) return json(gateway.runs);
    return json({}, 404);
  },
}));

const { GatewayMonitor } = await import('../src/main/gateways/monitor');

const stored = { id: 'gw-1', url: 'https://jian.example.com', sealedToken: '', addedAt: '' };
const store = { list: () => [stored], get: () => stored, token: () => 'synthetic-token' };

const reply = (at: string): ListedSession => ({
  id: 'chat-1',
  title: 'Release notes',
  channel: 'gateway',
  readAt: '2026-10-30T09:00:00.000Z',
  lastMessage: { role: 'assistant', text: 'Ready.', at },
});

/** A monitor on the gateway above, and every notice it gave. */
function watching() {
  const notices: Notice[] = [];
  const monitor = new GatewayMonitor(store as never, '1.1.3', {
    changed: () => {},
    noticed: (notice) => notices.push(notice),
  });
  return { monitor, notices };
}

/** Lets every request in flight, and what follows it, settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  vi.useRealTimers();
  Object.assign(gateway, { sessions: [], runs: [], failing: false, hold: undefined });
});

describe('the gateway monitor', () => {
  it('tells a new reply once, though the window asked for a look while one was under way', async () => {
    const { monitor, notices } = watching();
    gateway.sessions = [reply('2026-10-30T10:00:00.000Z')];
    monitor.watch(stored as never);
    await settle();
    expect(notices).toEqual([]);

    gateway.sessions = [reply('2026-10-30T10:05:00.000Z')];
    let release = () => {};
    gateway.hold = new Promise((resolve) => {
      release = resolve;
    });
    monitor.refresh('gw-1');
    monitor.refresh('gw-1');
    await settle();
    release();
    await settle();
    expect(notices.map((notice) => notice.text)).toEqual(['Ready.']);
    monitor.forget('gw-1');
  });

  it('keeps what it knew of an agent whose list failed, so its return is not a burst', async () => {
    const { monitor, notices } = watching();
    gateway.sessions = [reply('2026-10-30T10:00:00.000Z')];
    monitor.watch(stored as never);
    await settle();

    gateway.failing = true;
    monitor.refresh('gw-1');
    await settle();
    gateway.failing = false;
    monitor.refresh('gw-1');
    await settle();
    expect(notices).toEqual([]);
    expect(monitor.summaries()[0]?.unread).toBe(1);
    monitor.forget('gw-1');
  });

  it('tells the owner an agent waits on them', async () => {
    const { monitor, notices } = watching();
    gateway.sessions = [reply('2026-10-30T10:00:00.000Z')];
    monitor.watch(stored as never);
    await settle();

    gateway.runs = [
      {
        id: 'run-1',
        sessionId: 'chat-1',
        status: 'waiting',
        approval: { id: 'approval-1', title: 'Send the invoice to Ana' },
      },
    ];
    monitor.refresh('gw-1');
    await settle();
    expect(notices).toMatchObject([
      {
        gatewayId: 'gw-1',
        profileName: 'Ada',
        sessionId: 'chat-1',
        title: 'Release notes',
        text: 'Waiting for your approval: Send the invoice to Ana',
        asks: true,
      },
    ]);
    monitor.forget('gw-1');
  });
});

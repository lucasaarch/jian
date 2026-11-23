import { STREAM_OPENED_EVENT } from '@jian/contracts';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keys } from './keys';
import { affected, staleOf, staleReads } from './stale-events';

const touches = (type: string) =>
  affected({ id: 1, type }, 'profile').some(
    ({ key }) => JSON.stringify(key) === JSON.stringify(keys.sessionWorktrees('profile')),
  );

it('reads the worktrees again when a turn starts or ends, or one changes, not on every step', () => {
  // On a machine each read of them is a task on its worker.
  expect(touches('run.step')).toBe(false);
  expect(touches('run.progress')).toBe(false);
  // A paragraph the agent said changes no worktree.
  expect(touches('session.message')).toBe(false);
  for (const type of ['run.started', 'run.completed', 'run.failed', 'session.worktree']) {
    expect(touches(type)).toBe(true);
  }
});

it('reads the release notes again when the stream opens, so a gateway updated meanwhile shows', () => {
  // A desktop app stays open for days; the gateway behind it restarts on an update.
  const opened = affected({ id: 1, type: STREAM_OPENED_EVENT }, 'profile').map(({ key }) =>
    JSON.stringify(key),
  );
  expect(opened).toContain(JSON.stringify(keys.releases));
  expect(
    affected({ id: 2, type: 'run.completed' }, 'profile').map(({ key }) => key),
  ).not.toContainEqual(keys.releases);
});

it('reads nothing again for text alone, only when a turn at work changes what it is doing', () => {
  const stale = staleOf('profile');
  const RUN = '00000000-0000-4000-8000-000000000001';
  const frame = (progress: Record<string, unknown>) =>
    stale({
      id: 1,
      type: 'run.progress',
      data: {
        runId: RUN,
        sessionId: '00000000-0000-4000-8000-00000000005e',
        at: 'now',
        progress: { steps: 0, updatedAt: '2026-11-07T10:00:00.000Z', ...progress },
      },
    }).length;

  expect(frame({ phase: 'writing', text: 'Hel' })).toBeGreaterThan(0);
  expect(frame({ phase: 'writing', text: 'Hello' })).toBe(0);
  expect(frame({ phase: 'writing', text: 'Hello there' })).toBe(0);
  expect(frame({ phase: 'tool', tool: 'shell', text: '' })).toBeGreaterThan(0);
  expect(frame({ phase: 'tool', tool: 'read_file', text: '' })).toBeGreaterThan(0);
  expect(frame({ phase: 'tool', tool: 'read_file', text: '', steps: 1 })).toBeGreaterThan(0);
  // A gateway that says only that a run moved is read on every frame, as before.
  expect(
    stale({ id: 1, type: 'run.progress', data: { runId: RUN, sessionId: 'x', at: 'now' } }).length,
  ).toBeGreaterThan(0);
});

describe('costly reads while a turn works', () => {
  afterEach(() => vi.useRealTimers());

  const PROFILE = 'profile';
  const SESSION = '00000000-0000-4000-8000-00000000005e';

  /** A conversation on screen with its pull requests and context, from a counting gateway. */
  async function open() {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
    const gateway = { pulls: 0, context: 0, finalPulls: 'before' };
    const stops = [
      new QueryObserver(client, {
        queryKey: keys.sessionPulls(PROFILE, SESSION),
        queryFn: async () => {
          gateway.pulls += 1;
          return gateway.finalPulls;
        },
      }).subscribe(() => {}),
      new QueryObserver(client, {
        queryKey: keys.sessionContext(PROFILE, SESSION),
        queryFn: async () => {
          gateway.context += 1;
          return gateway.context;
        },
      }).subscribe(() => {}),
    ];
    await vi.advanceTimersByTimeAsync(0);
    gateway.pulls = 0;
    gateway.context = 0;
    const reads = staleReads(client);
    const stale = staleOf(PROFILE);
    const hear = (type: string) => reads.tell(stale({ id: 1, type }));

    return {
      client,
      gateway,
      reads,
      hear,
      close: () => {
        for (const stop of stops) stop();
      },
    };
  }

  it('reads pull requests and context a few times over a long turn, not on every step', async () => {
    const { gateway, reads, hear, close } = await open();

    for (let step = 0; step < 60; step++) {
      hear('run.step');
      await vi.advanceTimersByTimeAsync(500);
    }

    // Thirty seconds of steps, at most one read per five seconds.
    expect(gateway.pulls).toBeLessThanOrEqual(6);
    expect(gateway.context).toBeLessThanOrEqual(6);
    expect(gateway.pulls).toBeGreaterThan(0);
    reads.stop();
    close();
  });

  it('shows the final pull requests and context as soon as the turn ends', async () => {
    const { client, gateway, reads, hear, close } = await open();

    hear('run.step');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gateway.pulls).toBe(0);
    gateway.finalPulls = 'after';
    hear('run.completed');
    await vi.advanceTimersByTimeAsync(250);

    expect(client.getQueryData(keys.sessionPulls(PROFILE, SESSION))).toBe('after');
    expect(gateway.context).toBe(1);
    // The read the step had planned is covered by this one and does not come on top.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gateway.pulls).toBe(1);
    reads.stop();
    close();
  });

  it('a conversation not on screen reads its own again when it is opened', async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
    const key = keys.sessionContext(PROFILE, SESSION);
    client.setQueryData(key, 'old');
    const reads = staleReads(client);

    reads.tell(staleOf(PROFILE)({ id: 1, type: 'run.step' }));
    // The panel moves on before the paced read comes due; nothing is lost with it.
    reads.stop();
    const stop = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => 'new',
    }).subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(client.getQueryData(key)).toBe('new');
    stop();
  });
});

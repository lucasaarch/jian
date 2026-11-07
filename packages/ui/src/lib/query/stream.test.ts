import { STREAM_OPENED_EVENT } from '@jian/contracts';
import { expect, it } from 'vitest';
import { keys } from './keys';
import { affected, staleOf } from './stream';

const touches = (type: string) =>
  affected({ id: 1, type }, 'profile').some(
    (key) => JSON.stringify(key) === JSON.stringify(keys.sessionWorktrees('profile')),
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
  const opened = affected({ id: 1, type: STREAM_OPENED_EVENT }, 'profile').map((key) =>
    JSON.stringify(key),
  );
  expect(opened).toContain(JSON.stringify(keys.releases));
  expect(affected({ id: 2, type: 'run.completed' }, 'profile')).not.toContainEqual(keys.releases);
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

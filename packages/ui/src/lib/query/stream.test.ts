import { STREAM_OPENED_EVENT } from '@jian/contracts';
import { expect, it } from 'vitest';
import { keys } from './keys';
import { affected } from './stream';

const touches = (type: string) =>
  affected({ id: 1, type }, 'profile').some(
    (key) => JSON.stringify(key) === JSON.stringify(keys.sessionWorktrees('profile')),
  );

it('reads the worktrees again when a turn starts or ends, or one changes, not on every step', () => {
  // On a machine each read of them is a task on its worker.
  expect(touches('run.step')).toBe(false);
  expect(touches('run.progress')).toBe(false);
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

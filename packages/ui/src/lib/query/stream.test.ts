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

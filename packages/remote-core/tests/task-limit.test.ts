import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemoteTask } from '@jian/contracts';
import { withinTaskLimit } from '../src/task-limit.ts';

const task = (kind: RemoteTask['kind']): RemoteTask => ({
  id: '00000000-0000-4000-8000-000000000003',
  kind,
  command: '',
  cwd: null,
  timeoutMs: 10,
});

test('a task that never settles still gets an answer, so the worker polls again', async () => {
  const result = await withinTaskLimit(task('browser'), () => new Promise(() => {}), 10);
  assert.equal(result.timedOut, true);
  assert.match(result.browser?.error ?? '', /did not finish/);
});

test('a task that throws answers as failed instead of leaving the gateway waiting', async () => {
  const result = await withinTaskLimit(task('shell'), () => {
    throw new Error('spawn E2BIG');
  });
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr ?? '', /spawn E2BIG/);
});

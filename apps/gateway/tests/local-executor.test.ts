import { describe, expect, it } from 'vitest';
import { LocalExecutor } from '../src/runs/executors.js';

/** A run that ends when the test says so. */
function controlled() {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const execute = (_profileId: string, runId: string) =>
    new Promise<void>((resolve) => {
      started.push(runId);
      finish.set(runId, resolve);
    });
  return { started, finish, execute };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('runs executed in this process', () => {
  it('runs no more at once than its concurrency, and the next as one ends', async () => {
    const runs = controlled();
    const executor = new LocalExecutor(2);
    await executor.start(runs.execute);
    for (const id of ['a', 'b', 'c']) await executor.send('profile', id);
    expect(runs.started).toEqual(['a', 'b']);
    runs.finish.get('a')?.();
    await tick();
    expect(runs.started).toEqual(['a', 'b', 'c']);
  });

  it('runs a run once however often it is sent', async () => {
    const runs = controlled();
    const executor = new LocalExecutor(1);
    await executor.start(runs.execute);
    await executor.send('profile', 'a');
    await executor.send('profile', 'b');
    await executor.send('profile', 'a');
    await executor.send('profile', 'b');
    runs.finish.get('a')?.();
    await tick();
    runs.finish.get('b')?.();
    await tick();
    expect(runs.started).toEqual(['a', 'b']);
  });

  it('waits for what is running when it stops, and starts nothing it was still holding', async () => {
    const runs = controlled();
    const executor = new LocalExecutor(1);
    await executor.start(runs.execute);
    await executor.send('profile', 'a');
    await executor.send('profile', 'b');
    let stopped = false;
    const stopping = executor.stop().then(() => {
      stopped = true;
    });
    await tick();
    expect(stopped).toBe(false);
    runs.finish.get('a')?.();
    await stopping;
    expect(runs.started).toEqual(['a']);
  });
});

import { describe, expect, it } from 'vitest';
import { BossExecutor, LocalExecutor } from '../src/runs/executors.js';

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

describe('runs executed through pg-boss', () => {
  it('holds a run’s job past a long turn, on a queue made earlier too', async () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const boss = {
      on: () => {},
      start: async () => {},
      createQueue: async (name: string, options: Record<string, unknown>) => {
        calls.push(['create', name, options]);
      },
      updateQueue: async (name: string, options: Record<string, unknown>) => {
        calls.push(['update', name, options]);
      },
      work: async () => 'worker',
    };
    await new BossExecutor(boss as never).start(async () => {});

    const [create, update] = calls;
    expect(create?.[2]).toMatchObject({ policy: 'exclusive', retryLimit: 0 });
    // Above any turn: a waiting subagent call alone may hold one for 15 minutes.
    expect(Number(update?.[2].expireInSeconds)).toBeGreaterThanOrEqual(6 * 60 * 60);
    expect(update?.[2].heartbeatSeconds).toBeGreaterThanOrEqual(10);
    expect(update?.[2]).not.toHaveProperty('policy');
    expect(update?.[1]).toBe(create?.[1]);
  });
});

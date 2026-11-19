import { describe, expect, it } from 'vitest';
import {
  BossExecutor,
  LocalExecutor,
  RUN_CONCURRENCY,
  type RunExecutor,
  runConcurrencySchema,
} from '../src/runs/executors.js';
import { FULL_WARNING_MS, RunQueue } from '../src/runs/queue.js';
import { testServices } from './helpers/services.js';

describe('how many runs a gateway executes at once', () => {
  it('is JIAN_RUN_CONCURRENCY when set, and the default when it is empty or unset', () => {
    expect(runConcurrencySchema.parse('12')).toBe(12);
    expect(runConcurrencySchema.parse('')).toBe(RUN_CONCURRENCY);
    expect(runConcurrencySchema.parse(undefined)).toBe(RUN_CONCURRENCY);
    expect(runConcurrencySchema.safeParse('0').success).toBe(false);
    expect(runConcurrencySchema.safeParse('many').success).toBe(false);
  });

  it('is what pg-boss is told to run on this worker', async () => {
    let options: Record<string, unknown> = {};
    const boss = {
      on: () => {},
      start: async () => {},
      createQueue: async () => {},
      updateQueue: async () => {},
      work: async (_name: string, given: Record<string, unknown>) => {
        options = given;
        return 'worker';
      },
    };
    const executor = new BossExecutor(boss as never, () => {}, 7);
    await executor.start(async () => {});

    expect(options.localConcurrency).toBe(7);
    expect(executor.load()).toEqual({ working: 0, slots: 7 });
  });

  it('counts the runs holding a slot in this process', async () => {
    const finish: Array<() => void> = [];
    const executor = new LocalExecutor(2);
    await executor.start(() => new Promise<void>((resolve) => finish.push(resolve)));
    for (const id of ['a', 'b', 'c']) await executor.send('profile', id);

    expect(executor.load()).toEqual({ working: 2, slots: 2 });
    finish[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The waiting run took the freed slot.
    expect(executor.load()).toEqual({ working: 2, slots: 2 });
  });
});

describe('a run waiting for a free slot', () => {
  async function setup(load: { working: number; slots: number }) {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Coordinator',
      instructions: 'Help the owner.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const session = await services.sessions.createSession(profile.id, { channel: 'api' });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Summarise the week.',
      requestKey: 'waiting',
    });
    // An executor that takes nothing: every slot is held by runs of other conversations.
    const executor: RunExecutor = {
      start: async () => {},
      send: async () => {},
      stop: async () => {},
      load: () => load,
    };
    const runtime = {
      execute: async () => {},
      liveOwners: () => new Set<string>(),
      stop: () => {},
    };
    return { services, profile, run, executor, runtime };
  }

  it('says so in its progress, and no longer once it starts', async () => {
    const { services, profile, run, executor, runtime } = await setup({ working: 48, slots: 48 });
    const queue = new RunQueue(executor, services, runtime, () => {});
    await queue.start();
    await queue.stop();

    const waiting = await services.runs.run(profile.id, run.id);
    expect(waiting.status).toBe('queued');
    expect(waiting.progress?.queued).toEqual({ working: 48, slots: 48 });

    const started = await services.lifecycle.claim(run.id, profile.id, 'worker');
    expect(started?.status).toBe('running');
    expect((await services.runs.run(profile.id, run.id)).progress).toBeUndefined();
  });

  it('says nothing while a slot is free', async () => {
    const { services, profile, run, executor, runtime } = await setup({ working: 3, slots: 48 });
    const queue = new RunQueue(executor, services, runtime, () => {});
    await queue.start();
    await queue.stop();

    expect((await services.runs.run(profile.id, run.id)).progress).toBeUndefined();
  });

  it('is logged once every slot has been held for over a minute', async () => {
    const { services, executor, runtime } = await setup({ working: 2, slots: 2 });
    const reported: string[] = [];
    let now = 1_700_000_000_000;
    const queue = new RunQueue(
      executor,
      services,
      runtime,
      (line) => reported.push(line),
      () => {
        const at = now;
        // The next read of the queue comes a minute and a second later.
        now += FULL_WARNING_MS + 1000;
        return at;
      },
    );

    await queue.start();
    expect(reported).toEqual([]);
    await expect
      .poll(() => reported, { timeout: 6000, interval: 100 })
      .toEqual([expect.stringContaining('all 2 run slots have been busy for over a minute')]);
    await queue.stop();
    expect(reported[0]).toContain('JIAN_RUN_CONCURRENCY');
  });
});

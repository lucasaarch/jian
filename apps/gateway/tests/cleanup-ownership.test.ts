import type { MCPClient } from '@ai-sdk/mcp';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { AskUserPause } from '../src/agent/ask-user.js';
import * as mcp from '../src/agent/mcp.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import * as outbound from '../src/security/outbound.js';
import { runs } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(clock?: () => number) {
  const services = await testServices(clock);
  const profile = await services.profiles.createProfile({
    name: 'Cleanup verifier',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Cleanup' });
  const submit = (key: string) =>
    services.runs.submit(profile.id, session.id, { text: key, requestKey: key });
  const run = await submit('first');
  const marker = async () => {
    const [row] = await services.store.db
      .select({ owner: runs.executionOwner })
      .from(runs)
      .where(eq(runs.id, run.id));
    return row?.owner;
  };
  return { services, profile, run, submit, marker };
}

const model = () =>
  mockModel({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Verified.' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
      warnings: [],
    }),
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(['completed', 'failed', 'interrupted', 'waiting', 'cancelled'] as const)(
  'excludes a successor while a %s run retains an expired execution marker',
  async (status) => {
    const { services, profile, run, submit, marker } = await fixture();
    await services.lifecycle.claim(run.id, profile.id, 'original');
    await services.store.db
      .update(runs)
      .set({ status, executionUntil: new Date(0), leaseOwner: null, leaseUntil: null })
      .where(eq(runs.id, run.id));
    const successor = await submit('successor');
    expect(await services.lifecycle.claim(successor.id, profile.id, 'successor')).toBeNull();
    expect(await marker()).toBe('original');
    await services.lifecycle.releaseExecution(run.id, 'original');
    expect(await services.lifecycle.claim(successor.id, profile.id, 'successor')).not.toBeNull();
  },
);

it('never overwrites a marker on a queued run or clears it for a stale owner', async () => {
  const { services, profile, run, marker } = await fixture();
  await services.store.db
    .update(runs)
    .set({ executionOwner: 'original', executionUntil: new Date(0) })
    .where(eq(runs.id, run.id));
  expect(await services.lifecycle.claim(run.id, profile.id, 'replacement')).toBeNull();
  await services.lifecycle.releaseExecution(run.id, 'stale');
  expect(await marker()).toBe('original');
  await services.lifecycle.releaseExecution(run.id, 'original');
  expect(await services.lifecycle.claim(run.id, profile.id, 'replacement')).not.toBeNull();
  await services.lifecycle.releaseExecution(run.id, 'original');
  expect(await marker()).toBe('replacement');
});

it('recover interrupts an expired run lease without clearing its expired marker or replaying', async () => {
  let now = Date.now();
  const { services, profile, run, submit, marker } = await fixture(() => now);
  await services.lifecycle.claim(run.id, profile.id, 'original');
  await services.store.db
    .update(runs)
    .set({ executionUntil: new Date(0) })
    .where(eq(runs.id, run.id));
  now += 61_000;
  await services.lifecycle.recover();
  const recovered = await services.runs.run(profile.id, run.id);
  expect(recovered.status).toBe('interrupted');
  expect(recovered.leaseOwner).toBeUndefined();
  expect(await marker()).toBe('original');
  const successor = await submit('successor');
  expect(await services.lifecycle.claim(successor.id, profile.id, 'successor')).toBeNull();
  expect(await services.lifecycle.claim(run.id, profile.id, 'replay')).toBeNull();
  await services.lifecycle.recover();
  expect(await marker()).toBe('original');
});

it.each(['completed', 'waiting'] as const)(
  'stops the run heartbeat at %s and excludes a successor until cleanup has fully closed',
  async (status) => {
    const { services, profile, run, submit, marker } = await fixture();
    const closing = deferred();
    const closeStarted = deferred();
    const close = vi.fn(async () => {
      closeStarted.resolve();
      await closing.promise;
    });
    const connect = mcp.connectMcpTools;
    vi.spyOn(mcp, 'connectMcpTools').mockImplementation(async (claimed, tools, context) => {
      context.clients.push({ close } as unknown as MCPClient);
      if (status === 'waiting') throw new AskUserPause({ prompt: 'Which deployment?' });
      return connect(claimed, tools, context);
    });
    const heartbeat = vi.spyOn(services.lifecycle, 'heartbeat');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const executing = new AgentRuntime(services, model).execute(profile.id, run.id);
    await closeStarted.promise;
    expect((await services.runs.run(profile.id, run.id)).status).toBe(status);
    expect(await marker()).toBeTypeOf('string');
    const successor = await submit('successor');
    expect(await services.lifecycle.claim(successor.id, profile.id, 'successor')).toBeNull();
    const pulses = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeat).toHaveBeenCalledTimes(pulses);
    closing.resolve();
    await executing;
    expect(await marker()).toBeNull();
    expect(await services.lifecycle.claim(successor.id, profile.id, 'successor')).not.toBeNull();
  },
);

it('does not abort a terminal tail when an already pending heartbeat rejects', async () => {
  const { services, profile, run, marker } = await fixture();
  const defaultsStarted = deferred();
  const defaultsReady = deferred();
  const closing = deferred();
  const closeStarted = deferred();
  let rejectPulse = (_error: Error) => {};
  const pendingPulse = new Promise<void>((_resolve, reject) => {
    rejectPulse = reject;
  });
  vi.spyOn(services.lifecycle, 'heartbeat').mockImplementationOnce(() => pendingPulse);
  const modelDefaults = services.providers.modelDefaults.bind(services.providers);
  vi.spyOn(services.providers, 'modelDefaults').mockImplementation(async (profileId) => {
    defaultsStarted.resolve();
    await defaultsReady.promise;
    return modelDefaults(profileId);
  });
  let tailSignal: AbortSignal | undefined;
  const connect = mcp.connectMcpTools;
  vi.spyOn(mcp, 'connectMcpTools').mockImplementation(async (claimed, tools, context) => {
    tailSignal = context.signal;
    context.clients.push({
      close: async () => {
        closeStarted.resolve();
        await closing.promise;
      },
    } as unknown as MCPClient);
    return connect(claimed, tools, context);
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const executing = new AgentRuntime(services, model).execute(profile.id, run.id);
  await defaultsStarted.promise;
  await vi.advanceTimersByTimeAsync(10_000);
  defaultsReady.resolve();
  await closeStarted.promise;
  rejectPulse(new Error('Run lease is no longer valid'));
  await Promise.resolve();
  expect(tailSignal?.aborted).toBe(false);
  expect(await marker()).toBeTypeOf('string');
  closing.resolve();
  await executing;
  expect(await marker()).toBeNull();
});

it.each(['client', 'outbound'] as const)(
  'retains the marker when %s.close rejects, but still waits for all other resources',
  async (failure) => {
    const { services, profile, run, marker } = await fixture();
    const closing = deferred();
    const closeStarted = deferred();
    const create = outbound.createSafeFetch;
    const outboundClose = vi.fn(async () => {
      closeStarted.resolve();
      await closing.promise;
      if (failure === 'outbound') throw new Error('outbound close uncertain');
    });
    vi.spyOn(outbound, 'createSafeFetch').mockImplementation((options) => ({
      ...create(options),
      close: outboundClose,
    }));
    const clientClose = vi.fn(async () => {
      if (failure === 'client') throw new Error('client close uncertain');
    });
    const connect = mcp.connectMcpTools;
    vi.spyOn(mcp, 'connectMcpTools').mockImplementation(async (claimed, tools, context) => {
      context.clients.push({ close: clientClose } as unknown as MCPClient);
      return connect(claimed, tools, context);
    });
    const release = vi.spyOn(services.lifecycle, 'releaseExecution');
    const executing = new AgentRuntime(services, model).execute(profile.id, run.id);
    const rejected = expect(executing).rejects.toThrow('Run cleanup could not be confirmed');
    await closeStarted.promise;
    expect(await marker()).toBeTypeOf('string');
    expect(release).not.toHaveBeenCalled();
    closing.resolve();
    await rejected;
    expect(clientClose).toHaveBeenCalledOnce();
    expect(outboundClose).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(await marker()).toBeTypeOf('string');
  },
);

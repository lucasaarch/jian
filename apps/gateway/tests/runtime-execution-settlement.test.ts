import { tool } from 'ai';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as mcpModule from '../src/agent/mcp.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import * as outboundModule from '../src/security/outbound.js';
import { runs } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const answer = () => ({
  content: [{ type: 'text' as const, text: 'Done.' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Worker',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, {});
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'one',
  });
  const marker = async () =>
    (await services.store.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.executionOwner;
  return { services, profile, run, marker };
}
afterEach(() => vi.restoreAllMocks());

it('retains the marker from finish through late peer/objective/learning/naming and cleanup', async () => {
  const { services, profile, run, marker } = await fixture();
  const late = gate();
  const entered = gate();
  const sequence: string[] = [];
  vi.spyOn(services.peers, 'deliverLate').mockImplementation(async () => {
    expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
    expect(await marker()).toBeTruthy();
    sequence.push('peer');
    entered.release();
    await late.promise;
  });
  const objectives = {
    continueAfter: vi.fn(async () => {
      expect(await marker()).toBeTruthy();
      sequence.push('objective');
      return null;
    }),
  };
  const learning = {
    consider: vi.fn(async () => {
      expect(await marker()).toBeTruthy();
      sequence.push('learning');
      return undefined;
    }),
  };
  vi.spyOn(services.sessions, 'nameIfUnnamed').mockImplementation(async () => {
    expect(await marker()).toBeTruthy();
    sequence.push('name');
  });
  const original = outboundModule.createSafeFetch;
  vi.spyOn(outboundModule, 'createSafeFetch').mockImplementation(() => {
    const outbound = original();
    return {
      ...outbound,
      close: async () => {
        expect(await marker()).toBeTruthy();
        sequence.push('cleanup');
        await outbound.close();
      },
    };
  });
  const runtime = new AgentRuntime({ ...services, objectives, learning }, () =>
    mockModel({ doGenerate: async () => answer() }),
  );
  const execution = runtime.execute(profile.id, run.id);
  await entered.promise;
  expect(await marker()).toBeTruthy();
  late.release();
  await execution;
  expect(sequence).toEqual(['peer', 'objective', 'learning', 'name', 'cleanup']);
  expect(await marker()).toBeNull();
});

it('drains an abort-resistant tool and queued calls, but retains ownership even after local drainage', async () => {
  const { services, profile, run, marker } = await fixture();
  const entered = gate();
  const release = gate();
  const remember = services.memories.remember.bind(services.memories);
  const calls = vi.spyOn(services.memories, 'remember').mockImplementation(async (...args) => {
    entered.release();
    await release.promise;
    return remember(...args);
  });
  let step = 0;
  const model = mockModel({
    doGenerate: async () =>
      step++ === 0
        ? {
            content: ['first', 'second'].map((key) => ({
              type: 'tool-call' as const,
              toolCallId: key,
              toolName: 'remember',
              input: JSON.stringify({ key, content: 'Durable fact', expectedVersion: 0 }),
            })),
            finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
            usage,
            warnings: [],
          }
        : answer(),
  });
  const runtime = new AgentRuntime(services, () => model);
  let finished = false;
  const execution = runtime.execute(profile.id, run.id).then(() => {
    finished = true;
  });
  await entered.promise;
  await services.runs.cancel(profile.id, run.id);
  runtime.cancel(run.id);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(finished).toBe(false);
  expect(await marker()).toBeTruthy();
  release.release();
  await execution;
  expect(calls).toHaveBeenCalledTimes(1);
  expect(await services.memories.memories(profile.id)).toMatchObject([{ key: 'first' }]);
  expect(await marker()).toBeTruthy();
});

it('drains an already-running interval heartbeat before settlement', async () => {
  const { services, profile, run, marker } = await fixture();
  const entered = gate();
  const late = gate();
  const heartbeat = gate();
  const generating = gate();
  const finishModel = gate();
  let tick: (() => void) | undefined;
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay === 10_000) tick = () => callback(...args);
    return interval(callback, delay, ...args);
  });
  vi.spyOn(services.peers, 'deliverLate').mockImplementation(async () => {
    entered.release();
    await late.promise;
  });
  let done = false;
  const execution = new AgentRuntime(services, () =>
    mockModel({
      doGenerate: async () => {
        generating.release();
        await finishModel.promise;
        return answer();
      },
    }),
  )
    .execute(profile.id, run.id)
    .then(() => {
      done = true;
    });
  await generating.promise;
  const originalHeartbeat = services.lifecycle.heartbeat.bind(services.lifecycle);
  const pulses = vi.spyOn(services.lifecycle, 'heartbeat').mockImplementation(async (...args) => {
    await heartbeat.promise;
    await originalHeartbeat(...args);
  });
  expect(tick).toBeDefined();
  tick?.();
  finishModel.release();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(done).toBe(false);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('running');
  expect(await marker()).toBeTruthy();
  heartbeat.release();
  await entered.promise;
  const count = pulses.mock.calls.length;
  tick?.(); // A timer already queued before clearInterval must not heartbeat a terminal run.
  expect(pulses).toHaveBeenCalledTimes(count);
  late.release();
  await execution;
  expect(await marker()).toBeNull();
});

it.each(['unavailable', 'invoked'] as const)(
  'settles known MCP success, but retains unknown discovery failures: %s',
  async (mode) => {
    const { services, profile, run, marker } = await fixture();
    const discover = mcpModule.connectMcpTools;
    const called = vi.fn(async () => 'Known successful result');
    vi.spyOn(mcpModule, 'connectMcpTools').mockImplementation(async (current, tools, context) => {
      const result = await discover(current, tools, context);
      if (mode === 'unavailable')
        return { ...result, unavailable: [{ name: 'test', reason: 'discovery failed' }] };
      tools.mcp_test = tool({
        description: 'Test MCP tool',
        inputSchema: z.object({}),
        execute: called,
      });
      return { ...result, mcpToolNames: ['mcp_test'], selectedMcpTools: new Set(['mcp_test']) };
    });
    let step = 0;
    const model = mockModel({
      doGenerate: async () =>
        mode === 'invoked' && step++ === 0
          ? {
              content: [
                { type: 'tool-call', toolCallId: 'mcp-call', toolName: 'mcp_test', input: '{}' },
              ],
              finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
              usage,
              warnings: [],
            }
          : answer(),
    });
    await new AgentRuntime(services, () => model).execute(profile.id, run.id);
    expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
    expect(called).toHaveBeenCalledTimes(mode === 'invoked' ? 1 : 0);
    if (mode === 'invoked') expect(await marker()).toBeNull();
    else expect(await marker()).toBeTruthy();
  },
);

it.each(['owner-message', 'answer-api'] as const)(
  'settles ask_user and its resumed run before reset/delete: %s',
  async (mode) => {
    const { services, profile, run, marker } = await fixture();
    const runtime = new AgentRuntime(services, () =>
      mockModel({
        doGenerate: async () => ({
          content: [
            {
              type: 'tool-call',
              toolCallId: 'ask',
              toolName: 'ask_user',
              input: JSON.stringify({ prompt: 'Ship it?' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        }),
      }),
    );
    await runtime.execute(profile.id, run.id);
    expect((await services.runs.run(profile.id, run.id)).status).toBe('waiting');
    expect(await marker()).toBeNull();
    const resumed =
      mode === 'answer-api'
        ? await services.runs.answerRun(profile.id, run.id, { text: 'Yes' })
        : await services.runs.submit(
            profile.id,
            run.sessionId,
            { text: 'Yes', requestKey: 'reply' },
            { ownerMessage: true },
          );
    expect(resumed.id).not.toBe(run.id);
    expect(resumed.continuationOf).toBe(run.id);
    await new AgentRuntime(services, () => mockModel({ doGenerate: async () => answer() })).execute(
      profile.id,
      resumed.id,
    );
    expect((await services.runs.run(profile.id, resumed.id)).status).toBe('completed');
    expect(
      (await services.store.db.select().from(runs).where(eq(runs.id, resumed.id)))[0]
        ?.executionOwner,
    ).toBeNull();
    await services.profiles.resetProfile(profile.id);
    await expect(services.profiles.deleteProfile(profile.id)).resolves.toEqual({ id: profile.id });
  },
);

it('retains ownership when resource setup throws before cleanup can be established', async () => {
  const { services, profile, run, marker } = await fixture();
  vi.spyOn(outboundModule, 'createSafeFetch').mockImplementation(() => {
    throw new Error('setup uncertain');
  });
  await expect(new AgentRuntime(services).execute(profile.id, run.id)).rejects.toThrow(
    'setup uncertain',
  );
  expect(await marker()).toBeTruthy();
});

it('drains an in-flight SDK step callback on abort and retains ownership', async () => {
  const { services, profile, run, marker } = await fixture();
  const entered = gate();
  const release = gate();
  vi.spyOn(services.lifecycle, 'recordUsage').mockImplementation(async () => {
    entered.release();
    await release.promise;
  });
  const runtime = new AgentRuntime(services, () => mockModel({ doGenerate: async () => answer() }));
  let done = false;
  const execution = runtime.execute(profile.id, run.id).then(() => {
    done = true;
  });
  await entered.promise;
  runtime.cancel(run.id);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(done).toBe(false);
  expect(await marker()).toBeTruthy();
  release.release();
  await execution;
  expect(await marker()).toBeTruthy();
});

it.each(['recordUsage', 'progress', 'finish'] as const)(
  'retains ownership after persistence failure: %s',
  async (method) => {
    const { services, profile, run, marker } = await fixture();
    vi.spyOn(services.lifecycle, method).mockRejectedValue(new Error('persistence failed'));
    await new AgentRuntime(services, () => mockModel({ doGenerate: async () => answer() })).execute(
      profile.id,
      run.id,
    );
    expect(await marker()).toBeTruthy();
  },
);

it.each(['cancel', 'wait-failure'] as const)(
  'retains ownership on an unsafe intentional pause: %s',
  async (mode) => {
    const { services, profile, run, marker } = await fixture();
    const runtime = new AgentRuntime(services, () =>
      mockModel({
        doGenerate: async () => ({
          content: [
            {
              type: 'tool-call',
              toolCallId: 'ask',
              toolName: 'ask_user',
              input: JSON.stringify({ prompt: 'Continue?' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        }),
      }),
    );
    if (mode === 'cancel')
      vi.spyOn(services.sessions, 'nameIfUnnamed').mockImplementation(async () =>
        runtime.cancel(run.id),
      );
    else
      vi.spyOn(services.lifecycle, 'wait').mockRejectedValue(new Error('wait persistence failed'));
    await runtime.execute(profile.id, run.id);
    expect(await marker()).toBeTruthy();
  },
);

it('retains ownership when owned outbound cleanup fails', async () => {
  const { services, profile, run, marker } = await fixture();
  const original = outboundModule.createSafeFetch;
  vi.spyOn(outboundModule, 'createSafeFetch').mockImplementation(() => {
    const outbound = original();
    return {
      ...outbound,
      close: async () => {
        await outbound.close();
        throw new Error('close uncertain');
      },
    };
  });
  await new AgentRuntime(services, () => mockModel({ doGenerate: async () => answer() })).execute(
    profile.id,
    run.id,
  );
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  expect(await marker()).toBeTruthy();
});

it('covers setup failure after claim and settles only after successfully cleaning up', async () => {
  const { services, profile, run, marker } = await fixture();
  const entered = gate();
  const release = gate();
  const original = outboundModule.createSafeFetch;
  vi.spyOn(outboundModule, 'createSafeFetch').mockImplementation(() => {
    const outbound = original();
    return {
      ...outbound,
      close: async () => {
        entered.release();
        await release.promise;
        await outbound.close();
      },
    };
  });
  const profileLookup = services.profiles.profile.bind(services.profiles);
  let profileCalls = 0;
  vi.spyOn(services.profiles, 'profile').mockImplementation(async (...args) => {
    // Claiming the run reads the profile once before execute's resource setup.
    if (profileCalls++ === 0) return profileLookup(...args);
    throw new Error('setup failed');
  });
  const execution = new AgentRuntime(services, () =>
    mockModel({ doGenerate: async () => answer() }),
  ).execute(profile.id, run.id);
  await entered.promise;
  expect(await marker()).toBeTruthy();
  release.release();
  await execution;
  expect(await marker()).toBeNull();
});

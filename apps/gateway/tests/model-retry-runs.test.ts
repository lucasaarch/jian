import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import type { RunProgress } from '@jian/contracts';
import { errors } from 'undici';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { GatewayError } from '../src/core/errors.js';
import { createSafeFetch } from '../src/security/outbound.js';
import {
  type ClaudeReply,
  type ClaudeRequest,
  fakeClaude,
  isSummary,
  sentTools,
} from './helpers/claude.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

/** A turn of a run, as the runtime drives it: what reaches the model, and what it reports. */

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const answer = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});

async function conversation(model: { provider: string; modelId: string }) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { ...model, apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: { inputTokens: 64000 },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Deploys' });
  const ask = (sessionId = session.id) =>
    services.runs.submit(profile.id, sessionId, {
      text: 'Check the deploy',
      requestKey: randomUUID(),
    });
  // Every progress frame the run writes, in order.
  const told: RunProgress[] = [];
  const progress = services.lifecycle.progress.bind(services.lifecycle);
  services.lifecycle.progress = async (runId, owner, frame) => {
    if (frame) told.push(frame);
    await progress(runId, owner, frame);
  };
  return { services, profile, ask, told };
}

/** A safeFetch whose every request times out connecting, planted in its lookup. */
const unreachable = () =>
  createSafeFetch({
    lookup: async () => {
      throw new errors.ConnectTimeoutError();
    },
  });

afterEach(() => {
  vi.useRealTimers();
});

it('stops saying it is reconnecting when a waited call is refused, and sends the narrowed step once', async () => {
  const modelId = 'claude-opus-4-7';
  const { services, profile, ask, told } = await conversation({ provider: 'anthropic', modelId });
  const run = await ask();
  // Overloaded twice, then the deferred form refused: the fallback sends it once without it.
  const plan: ClaudeReply[] = [
    { overloaded: true },
    { overloaded: true },
    { refuse: 'tools.3.defer_loading: Extra inputs are not permitted' },
    { text: 'Deploy is green.' },
  ];
  let step = 0;
  const isStep = (request: ClaudeRequest) => request.stream === true && !isSummary(request);
  const claude = fakeClaude(modelId, (request) =>
    isStep(request) ? (plan[step++] ?? { text: 'Again?' }) : { text: 'Done.' },
  );
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await new AgentRuntime(services, () => claude.model, { modelRetryDelay: () => 5 }).execute(
      profile.id,
      run.id,
    );
  } finally {
    spy.mockRestore();
  }

  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.output).toBe('Deploy is green.');
  const sent = claude.requests.filter(isStep);
  expect(sent).toHaveLength(4);
  expect(
    sent.slice(0, 3).every((request) => sentTools(request).some((item) => item.deferred)),
  ).toBe(true);
  expect(sentTools(sent[3]).some((item) => item.deferred)).toBe(false);
  expect(told.some((frame) => frame.reconnecting)).toBe(true);
  expect(told.at(-1)).not.toHaveProperty('reconnecting');
});

it('waits out more than a round for a conversation, but gives a look back one round', async () => {
  const { services, profile, ask } = await conversation({ provider: 'openai', modelId: 'test' });
  const outbound = unreachable();
  const failing = (failures: number) => {
    let attempts = 0;
    const model = mockModel({
      doGenerate: async () => {
        attempts += 1;
        if (attempts <= failures) await outbound.fetch('https://api.provider.test/v1/chat');
        return answer('Looked.');
      },
    });
    return { model, attempts: () => attempts };
  };
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const owner = failing(12);
    const run = await ask();
    await new AgentRuntime(services, () => owner.model, { modelRetryDelay: () => 1 }).execute(
      profile.id,
      run.id,
    );
    expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
    expect(owner.attempts()).toBe(13);

    const learning = await services.sessions.learningSession(profile.id);
    const look = failing(Number.POSITIVE_INFINITY);
    const lookBack = await ask(learning.id);
    await new AgentRuntime(services, () => look.model, { modelRetryDelay: () => 1 }).execute(
      profile.id,
      lookBack.id,
    );
    const failed = await services.runs.run(profile.id, lookBack.id);
    expect(failed.status).toBe('failed');
    expect(look.attempts()).toBe(10);
  } finally {
    spy.mockRestore();
    await outbound.close();
  }
});

it("fails at once on a 429 that is a spent quota, with the provider's words", async () => {
  const { services, profile, ask } = await conversation({ provider: 'openai', modelId: 'test' });
  const run = await ask();
  let attempts = 0;
  const model = createOpenAI({
    apiKey: 'synthetic-openai-key',
    baseURL: 'https://api.openai.test/v1',
    fetch: (async () => {
      attempts += 1;
      return Response.json(
        {
          error: {
            message: 'You exceeded your current quota, please check your plan.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        },
        { status: 429 },
      );
    }) as typeof globalThis.fetch,
  }).chat('gpt-test');
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await new AgentRuntime(services, () => model, { modelRetryDelay: () => 1 }).execute(
      profile.id,
      run.id,
    );
  } finally {
    spy.mockRestore();
  }

  const failed = await services.runs.run(profile.id, run.id);
  expect(failed.status).toBe('failed');
  expect(failed.error).toContain('You exceeded your current quota');
  expect(attempts).toBe(1);
});

it('ends a wait the moment the run loses its lease', async () => {
  // Only the intervals are fake: the lease pulse is one, and the wait itself stays real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { services, profile, ask } = await conversation({ provider: 'openai', modelId: 'test' });
  const run = await ask();
  const outbound = unreachable();
  let attempts = 0;
  const model = mockModel({
    doGenerate: async () => {
      attempts += 1;
      await outbound.fetch('https://api.provider.test/v1/chat');
      return answer('Never.');
    },
  });
  const heartbeat = services.lifecycle.heartbeat.bind(services.lifecycle);
  services.lifecycle.heartbeat = async (...args) => {
    // Another worker took the run while this one waited on the model.
    if (attempts > 0) throw new GatewayError(409, 'Run lease is held by another worker');
    return heartbeat(...args);
  };
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const started = Date.now();
    const execution = new AgentRuntime(services, () => model, {
      modelRetryDelay: () => 60_000,
    }).execute(profile.id, run.id);
    while (attempts === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The pulse's next beat: ten seconds of a sixty-second lease.
    vi.advanceTimersByTime(10_000);
    await execution;

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(attempts).toBe(1);
    expect((await services.runs.run(profile.id, run.id)).status).toBe('interrupted');
  } finally {
    spy.mockRestore();
    await outbound.close();
  }
});

it('keeps the stall watchdog fed through a wait longer than it allows', async () => {
  const { services, profile, ask } = await conversation({ provider: 'openai', modelId: 'test' });
  const run = await ask();
  const outbound = unreachable();
  let attempts = 0;
  const model = mockModel({
    doGenerate: async () => {
      attempts += 1;
      if (attempts === 1) await outbound.fetch('https://api.provider.test/v1/chat');
      return answer('Through.');
    },
  });
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await new AgentRuntime(services, () => model, {
      stalledAfterMs: 400,
      modelRetryDelay: () => 1_500,
    }).execute(profile.id, run.id);
  } finally {
    spy.mockRestore();
    await outbound.close();
  }

  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.status).toBe('completed');
  expect(finished.output).toBe('Through.');
});

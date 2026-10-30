import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { insertMessage } from '../src/sessions/repository.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

const usageOf = (inputTokens: number) => ({
  inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
});

const answer = (text: string, inputTokens = 10) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: usageOf(inputTokens),
  warnings: [],
});

async function conversation() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { title: 'Release' });
  return { services, profile, session };
}

it('reads an empty conversation as measured by nothing yet', async () => {
  const { services, profile, session } = await conversation();

  const context = await services.sessions.context(profile.id, session.id);

  expect(context.used).toBeNull();
  expect(context.limit).toBe(
    profile.contextPolicy.inputTokens - profile.contextPolicy.outputTokens,
  );
  expect(context.totals).toEqual({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    turns: 0,
  });
  expect(context.compacted).toBeNull();
});

it('reads the input of the last call and adds up the turns', async () => {
  const { services, profile, session } = await conversation();
  for (const [index, size] of [1_200, 4_800].entries()) {
    const run = await services.runs.submit(profile.id, session.id, {
      text: `Question ${index}`,
      requestKey: `turn-${index}`,
    });
    const model = mockModel({ doGenerate: async () => answer('Answered.', size) });
    await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  }

  const context = await services.sessions.context(profile.id, session.id);

  expect(context.used).toBe(4_800);
  expect(context.totals.turns).toBe(2);
  expect(context.totals.inputTokens).toBeGreaterThanOrEqual(6_000);
  expect(context.compactAt).toBeLessThan(context.limit);
});

it('compacts on /compact before the agent is asked anything, and lets it only say so', async () => {
  const { services, profile, session } = await conversation();
  for (let index = 0; index < 6; index++) {
    await insertMessage(services.store.db, {
      id: randomUUID(),
      profileId: profile.id,
      sessionId: session.id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${index} ${'history '.repeat(300)}`,
      createdAt: new Date(Date.parse('2026-10-30T09:00:00.000Z') + index * 1000).toISOString(),
    });
  }
  const run = await services.runs.submit(profile.id, session.id, {
    text: '/compact',
    requestKey: 'compact',
  });
  const asked: { tools: number; prompt: string }[] = [];
  const model = mockModel({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (!prompt.includes('asked to compact')) return answer('The earlier turns, in short.');
      asked.push({ tools: options.tools?.length ?? 0, prompt });
      return answer('Done: the context is compacted.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.status).toBe('completed');
  expect(finished.output).toBe('Done: the context is compacted.');
  expect(asked).toHaveLength(1);
  expect(asked[0]?.tools).toBe(0);
  expect(asked[0]?.prompt).toContain('was compacted from about');
  expect(asked[0]?.prompt).not.toContain('"/compact"');

  const context = await services.sessions.context(profile.id, session.id);
  expect(context.compacted).not.toBeNull();
  expect(context.compacted?.afterTokens).toBeLessThan(context.compacted?.beforeTokens ?? 0);
});

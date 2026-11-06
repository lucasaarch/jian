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
    cacheWriteTokens: 0,
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
  const run = await services.runs.submit(
    profile.id,
    session.id,
    { text: '/compact', requestKey: 'compact' },
    { ownerMessage: true },
  );
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

  // A command, not something said: kept for the record, left out of the chat.
  const sent = (await services.sessions.messages(profile.id, session.id)).find(
    (message) => message.runId === run.id && message.role === 'user',
  );
  expect(sent?.purpose).toBe('compact');

  const context = await services.sessions.context(profile.id, session.id);
  expect(context.compacted).not.toBeNull();
  expect(context.compacted?.afterTokens).toBeLessThan(context.compacted?.beforeTokens ?? 0);
});

it('tells the owner why /compact failed instead of saying there was nothing to compact', async () => {
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
  const run = await services.runs.submit(
    profile.id,
    session.id,
    { text: '/compact', requestKey: 'compact-quota' },
    { ownerMessage: true },
  );
  const told: string[] = [];
  const model = mockModel({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (!prompt.includes('asked to compact')) throw new Error('HTTP 429: quota exceeded');
      told.push(prompt);
      return answer('Compaction failed: the provider quota is spent.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  expect(told).toHaveLength(1);
  expect(told[0]).toContain('Compaction failed');
  expect(told[0]).toContain('quota exceeded');
  expect(told[0]).not.toContain('nothing old enough');
});

it('compacts once on /compact sent while a turn runs, without telling the agent the words', async () => {
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
  const run = await services.runs.submit(
    profile.id,
    session.id,
    { text: 'Check the deploy', requestKey: 'deploy' },
    { ownerMessage: true },
  );
  let clicked = false;
  let summariesAfter = 0;
  const prompts: string[] = [];
  const model = mockModel({
    doGenerate: async (options) => {
      if (!options.tools?.length) {
        if (clicked) summariesAfter++;
        return answer('The earlier turns, in short.');
      }
      if (!clicked) {
        // Clicked again and again for want of a sign it was heard: each joins the turn at work.
        for (const key of ['compact-1', 'compact-2', 'compact-3']) {
          const joined = await services.runs.submit(
            profile.id,
            session.id,
            { text: '/compact', requestKey: key },
            { ownerMessage: true },
          );
          expect(joined.id).toBe(run.id);
        }
        clicked = true;
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'read',
              toolName: 'read_memories',
              input: '{}',
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
          usage: usageOf(10),
          warnings: [],
        };
      }
      prompts.push(JSON.stringify(options.prompt));
      return answer('The deploy is fine.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.output).toBe('The deploy is fine.');
  expect(summariesAfter).toBe(1);
  expect(prompts.join('')).not.toContain('/compact');
});

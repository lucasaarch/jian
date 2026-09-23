import type { Message } from '@jian/contracts';
import { tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fitPrompt, promptTokens, tokenCounter } from '../src/context/budget.js';
import { buildContext } from '../src/context/build.js';
import { compactPrompt, needsCompaction } from '../src/context/compaction.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

async function fixture() {
  const services = await testServices();

  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help the owner.',
    identity: {
      role: 'Researcher',
      tone: 'Concise',
      goals: ['Find deployment facts'],
      boundaries: ['No external writes'],
    },
    model: { provider: 'openai', modelId: 'gpt-4o', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    skills: [
      { name: 'lookup', description: 'Search the catalog', instructions: 'Private skill body' },
    ],
  });

  const session = await services.sessions.createSession(profile.id, { title: 'Test' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'When was the deployment?',
    requestKey: 'one',
  });

  return { services, profile, session, run };
}

describe('context', () => {
  it('retains a Unicode current turn when the older-history budget is zero', async () => {
    const services = await testServices();

    const profile = await services.profiles.createProfile({
      name: 'Zero history',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'gpt-4o', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      contextPolicy: { historyTokens: 0 },
    });

    const session = await services.sessions.createSession(profile.id, { title: 'Unicode' });

    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Olá 世界 🌍',
      requestKey: 'current',
    });

    const context = await services.contexts.context(run);

    expect(context.messages).toEqual([{ role: 'user', content: 'Olá 世界 🌍' }]);
  });

  it('includes structured identity and a skill catalog while selecting relevant memories', async () => {
    const { services, profile, run } = await fixture();

    await services.memories.remember(profile.id, {
      key: 'deployment',
      content: 'Deployment completed at 21:00',
      expectedVersion: 0,
    });

    await services.memories.remember(profile.id, {
      key: 'weather',
      content: 'Forecast is sunny',
      expectedVersion: 0,
    });

    const context = buildContext(run, {
      memories: await services.memories.memories(profile.id),
      activities: [],
      history: await services.sessions.messages(profile.id, run.sessionId),
    });

    expect(context.system).toContain('Researcher');
    expect(context.system).toContain('No external writes');
    expect(context.system).toContain('Deployment completed at 21:00');
    expect(context.system).not.toContain('Forecast is sunny');
    expect(context.system).toContain('Search the catalog');
    expect(context.system).not.toContain('Private skill body');
    expect(context.messages.at(-1)?.content).toBe('When was the deployment?');
  });

  it('keeps complete tool-call/result pairs while trimming old blocks to fit the total budget', () => {
    const messages = [
      { role: 'user' as const, content: 'old'.repeat(5000) },
      { role: 'assistant' as const, content: 'old answer'.repeat(3000) },
      { role: 'user' as const, content: 'current question' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool-call' as const, toolCallId: 'latest', toolName: 'search', input: {} },
        ],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'latest',
            toolName: 'search',
            output: { type: 'text' as const, value: 'answer' },
          },
        ],
      },
    ];

    const fitted = fitPrompt({
      provider: 'anthropic',
      modelId: 'test',
      policy: { inputTokens: 4096, outputTokens: 256 },
      instructions: 'Answer carefully.',
      messages,
      tools: {},
    });

    expect(fitted.messages.some((m) => m.role === 'user' && m.content === 'current question')).toBe(
      true,
    );

    expect(
      fitted.messages.some((m) => m.role === 'user' && m.content === messages[0]?.content),
    ).toBe(false);

    expect(fitted.messages.filter((m) => m.role === 'tool')).toHaveLength(1);

    expect(
      fitted.messages.filter((m) => m.role === 'assistant' && Array.isArray(m.content)),
    ).toHaveLength(1);

    expect(fitted.tokens).toBeLessThanOrEqual(4096 - 256);
  });

  it('fails if the mandatory current turn and tool schemas cannot fit with output reserved', () => {
    expect(() =>
      fitPrompt({
        provider: 'anthropic',
        modelId: 'test',
        policy: { inputTokens: 4096, outputTokens: 256 },
        instructions: 'x'.repeat(5000),
        messages: [{ role: 'user', content: 'current' }],
        tools: {},
      }),
    ).toThrow('Context budget exceeded');
  });

  it('charges exposed tool descriptions and schemas against the input budget', () => {
    const tools = {
      oversized: tool({
        description: 'x'.repeat(5000),
        inputSchema: z.object({ query: z.string() }),
      }),
    };

    expect(() =>
      fitPrompt({
        provider: 'anthropic',
        modelId: 'test',
        policy: { inputTokens: 4096, outputTokens: 256 },
        instructions: 'Answer.',
        messages: [{ role: 'user', content: 'Find this' }],
        tools,
      }),
    ).toThrow('Context budget exceeded');
  });
});

it('counts special-token literals as ordinary input', () => {
  const first = tokenCounter('openai', 'gpt-4o');

  expect(first('Explain <|endoftext|> literally.')).toBeGreaterThan(0);
});

describe('compaction', () => {
  const message = (id: string, content: string, at: string): Message => ({
    id,
    profileId: '11111111-1111-4111-8111-111111111111',
    sessionId: '33333333-3333-4333-8333-333333333333',
    runId: '22222222-2222-4222-8222-222222222222',
    role: 'user',
    content,
    createdAt: at,
  });

  it('replaces the older turns and keeps the recent ones as written', async () => {
    const history = Array.from({ length: 12 }, (_, index) =>
      message(
        `m${index}`,
        `turn ${index}: ${'details '.repeat(100)}`,
        new Date(1700000000000 + index * 1000).toISOString(),
      ),
    );

    let asked = '';

    const compacted = await compactPrompt({
      provider: 'openai',
      modelId: 'test',
      policy: { inputTokens: 16000, outputTokens: 512 },
      onUsage: async () => {},
      model: mockModel({
        doGenerate: async (options) => {
          asked = JSON.stringify(options.prompt);

          return {
            content: [{ type: 'text', text: '## Open request\nNone' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
            warnings: [],
          };
        },
      }),
      previous: undefined,
      messages: history.map(({ role, content }) => ({ role, content })),
      signal: AbortSignal.timeout(5000),
    });

    expect(compacted?.messages.at(-1)?.content).toBe(history[11]?.content);
    expect(asked).toContain('turn 9');
    expect(asked).not.toContain('turn 10');
  });

  it('summarizes all history through a compactor with a smaller context', async () => {
    const messages = Array.from({ length: 14 }, (_, index) => ({
      role: 'user' as const,
      content: `turn-${index}: ${'details '.repeat(200)}`,
    }));
    let consumed = '';
    const result = await compactPrompt({
      provider: 'test',
      modelId: 'small',
      policy: { inputTokens: 5000, outputTokens: 512 },
      messages,
      signal: AbortSignal.timeout(5000),
      onUsage: async () => {},
      model: mockModel({
        doGenerate: async (options) => {
          const user = options.prompt.filter((message) => message.role === 'user');
          consumed += user
            .map((message) =>
              message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
            )
            .join('');
          return {
            content: [{ type: 'text', text: 'Checkpoint with decisions.' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
            warnings: [],
          };
        },
      }),
    });
    expect(consumed).toBe(JSON.stringify(messages.slice(0, -2)));
    expect(result?.messages.at(-1)).toEqual(messages.at(-1));
    expect(result?.summary).toBe('Checkpoint with decisions.');
  });

  it('leaves a short conversation alone', async () => {
    const history = Array.from({ length: 3 }, (_, index) =>
      message(
        `m${index}`,
        `turn ${index}: ${'details '.repeat(100)}`,
        new Date(1700000000000 + index * 1000).toISOString(),
      ),
    );

    await expect(
      compactPrompt({
        provider: 'openai',
        modelId: 'test',
        policy: { inputTokens: 16000, outputTokens: 512 },
        onUsage: async () => {},
        model: mockModel({ doGenerate: async () => ({}) as never }),
        previous: undefined,
        messages: history.map(({ role, content }) => ({ role, content })),
        signal: AbortSignal.timeout(5000),
      }),
    ).resolves.toBeUndefined();
  });

  it('compacts only once the prompt is nearly full', () => {
    expect(needsCompaction(8600, 10000)).toBe(true);
    expect(needsCompaction(8000, 10000)).toBe(false);
  });
});

it('reserves pixel tokens for image files without counting their base64 transport', () => {
  const cost = (data: string) =>
    promptTokens({
      provider: 'anthropic',
      modelId: 'test',
      instructions: '',
      tools: {},
      messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data }] }],
    });
  expect(cost('AA==')).toBeGreaterThan(8192);
  expect(cost('AA==')).toBe(cost('AA=='.repeat(10000)));
});

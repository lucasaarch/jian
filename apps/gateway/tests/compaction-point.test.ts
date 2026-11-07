import { randomUUID } from 'node:crypto';
import type { CompactAt } from '@jian/contracts';
import { tool } from 'ai';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRuntime } from '../src/agent/runtime.js';
import { createApp } from '../src/app.js';
import { buildContext } from '../src/context/build.js';
import { compactionThreshold } from '../src/context/compaction.js';
import { insertMessage } from '../src/sessions/repository.js';
import { isSummary, mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('where a conversation is compacted', () => {
  it('is near the end of the window by default, and a set point never passes that', () => {
    // A 1M window with a 64k reserve, and a 128k one with 32k.
    expect(compactionThreshold(936_000)).toBe(773_217);
    expect(compactionThreshold(96_000)).toBe(79_304);
    expect(compactionThreshold(936_000, 'auto')).toBe(773_217);
    expect(compactionThreshold(936_000, 400_000)).toBe(400_000);
    // Past what the model can take, the next answer would not fit.
    expect(compactionThreshold(96_000, 500_000)).toBe(79_304);
  });
});

describe('the Compact at setting', () => {
  async function setup() {
    const services = await testServices();
    const app = createApp({ ...services, token, logger: false });
    apps.push(app);
    return { app, services };
  }

  it('starts at auto, is saved by the owner, and is refused to anyone without a token', async () => {
    const { app, services } = await setup();
    const profile = await services.profiles.createProfile(input);
    const url = `/v1/profiles/${profile.id}`;

    expect(profile.contextPolicy.compactAt).toBe('auto');

    const contextPolicy = { ...profile.contextPolicy, compactAt: 400_000 };
    const anonymous = await app.inject({
      method: 'PATCH',
      url,
      payload: { expectedVersion: 1, contextPolicy },
    });
    expect(anonymous.statusCode).toBe(401);

    const saved = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { expectedVersion: 1, contextPolicy },
    });
    expect(saved.statusCode).toBe(200);

    const read = (await app.inject({ url, headers })).json();
    expect(read.contextPolicy.compactAt).toBe(400_000);
    // Read back from the database, not from what the patch returned.
    expect((await services.profiles.profile(profile.id)).contextPolicy.compactAt).toBe(400_000);
  });

  it('refuses a point too early to be worth a summary', async () => {
    const { app, services } = await setup();
    const profile = await services.profiles.createProfile(input);

    for (const compactAt of [10_000, 'soon', 75_000.5]) {
      const refused = await app.inject({
        method: 'PATCH',
        url: `/v1/profiles/${profile.id}`,
        headers,
        payload: { expectedVersion: 1, contextPolicy: { ...profile.contextPolicy, compactAt } },
      });
      expect(refused.statusCode).toBe(400);
    }
    expect((await services.profiles.profile(profile.id)).contextPolicy.compactAt).toBe('auto');
  });
});

/**
 * A long conversation on a 1M-token model. Counted a byte a token (Gemini has no tokenizer here),
 * and the provider reports 0.6 of the bytes sent: some 400,000 tokens, past where Jian used to
 * compact on any window and far from the end of this one.
 */
async function longConversation(compactAt: CompactAt) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    ...input,
    model: { provider: 'google', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: {
      inputTokens: 1_000_000,
      outputTokens: 64_000,
      historyTokens: 1_000_000,
      maxSteps: 6,
      compactAt,
    },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Long' });
  // Older turns worth summarising: a summary of them shrinks the request by more than a fifth.
  for (let index = 0; index < 8; index++) {
    await insertMessage(services.store.db, {
      id: randomUUID(),
      profileId: profile.id,
      sessionId: session.id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${index} ${'history '.repeat(8_000)}`,
      createdAt: new Date(Date.parse('2026-11-01T09:00:00.000Z') + index * 1000).toISOString(),
    });
  }
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Carry on',
    requestKey: 'long',
  });
  let summaries = 0;
  let step = 0;
  const sizes: number[] = [];
  const model = mockModel({
    doGenerate: async (options) => {
      const total = Math.round(
        Buffer.byteLength(JSON.stringify(options.prompt) + JSON.stringify(options.tools ?? [])) *
          0.6,
      );
      const usage = {
        inputTokens: { total, noCache: total, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      };
      const said = (text: string) => ({
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage,
        warnings: [],
      });
      if (isSummary(options)) {
        summaries++;
        return said('Checkpoint: the older turns were read.');
      }
      // The conversation's own steps, not the call that names it.
      if (options.tools?.length) sizes.push(total);
      // A few steps that each send the whole request again, then an answer.
      return step++ < 3
        ? {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: `look-${step}`,
                toolName: 'load_tools',
                input: JSON.stringify({ groups: ['files'] }),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
            usage,
            warnings: [],
          }
        : said('Done.');
    },
  });
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  const compacted = (await services.lifecycle.checkpoints(profile.id, run.id))
    .map((checkpoint) => checkpoint.data as { phase?: string; via?: string })
    .filter((data) => data.phase === 'context-compacted');
  return { summaries, sizes, compactions: compacted.length, via: compacted[0]?.via };
}

describe('a run', () => {
  it('does not compact a 1M-token conversation at a few hundred thousand tokens on auto', async () => {
    const { summaries, sizes } = await longConversation('auto');
    expect(Math.min(...sizes)).toBeGreaterThan(300_000);
    expect(summaries).toBe(0);
  });

  it('compacts at the point the owner set', async () => {
    const { summaries, sizes, compactions } = await longConversation(250_000);
    expect(summaries).toBeGreaterThan(0);
    expect(compactions).toBe(1);
    // The step after the summary sent the shorter request.
    expect(sizes.at(-1)).toBeLessThan(250_000);
  });

  it('says the point in use on the Context line and in the context ring', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      ...input,
      contextPolicy: { inputTokens: 1_000_000, outputTokens: 64_000, compactAt: 400_000 },
    });
    const session = await services.sessions.createSession(profile.id, { title: 'Line' });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Hello',
      requestKey: 'line',
    });

    const turn = buildContext(run, {
      servers: [],
      memories: [],
      activities: [],
      history: [],
    }).messages.at(-2)?.content;
    expect(turn).toMatch(/% of the way to 400,000, where Jian summarises the older turns\./);

    expect((await services.sessions.context(profile.id, session.id)).compactAt).toBe(400_000);
    // The owner moves it: the ring follows before the next turn has run.
    await services.profiles.updateProfile(profile.id, {
      expectedVersion: profile.version,
      contextPolicy: { ...profile.contextPolicy, compactAt: 'auto' },
    });
    expect((await services.sessions.context(profile.id, session.id)).compactAt).toBe(773_217);
  });
});

describe('a cold conversation', () => {
  it('past two segments is summarised in place, in one call', async () => {
    // Its first step, with nothing cached: some 560,000 tokens counted a byte each.
    const { summaries, compactions, via } = await longConversation(250_000);
    expect(compactions).toBe(1);
    expect(via).toBe('request');
    expect(summaries).toBe(1);
  });
});

describe('a conversation growing past the hard edge', () => {
  it('is summarised in place before any request has to be cut', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      ...input,
      // Counted a byte a token, so the provider's report sets a measured scale of 0.6.
      model: { provider: 'google', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      contextPolicy: {
        inputTokens: 100_000,
        outputTokens: 10_000,
        historyTokens: 100_000,
        toolResultTokens: 16_000,
        maxSteps: 24,
      },
    });
    const session = await services.sessions.createSession(profile.id, { title: 'Growing' });
    for (let index = 0; index < 8; index++) {
      await insertMessage(services.store.db, {
        id: randomUUID(),
        profileId: profile.id,
        sessionId: session.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `turn-${index} ${'history '.repeat(690)}`,
        createdAt: new Date(Date.parse('2026-11-03T09:00:00.000Z') + index * 1000).toISOString(),
      });
    }
    if (!services.web) throw new Error('Web tools unavailable');
    services.web.tools = () => ({
      large_result: tool({
        description: 'Return a synthetic result.',
        inputSchema: z.object({}),
        execute: async () => 'x'.repeat(next),
      }),
    });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Carry on',
      requestKey: 'growing',
    });
    const sizes: number[] = [];
    let step = 0;
    // Results of 2,400 tokens, then one of 9,000 that takes the request from under where it
    // compacts to past the hard edge in a single step.
    let next = 4_000;
    const model = mockModel({
      doGenerate: async (options) => {
        const total = Math.round(
          Buffer.byteLength(JSON.stringify(options.prompt) + JSON.stringify(options.tools ?? [])) *
            0.6,
        );
        const usage = {
          inputTokens: { total, noCache: total, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        };
        if (isSummary(options) || !options.tools?.length) {
          return {
            content: [{ type: 'text' as const, text: 'Checkpoint: the older turns were read.' }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
            warnings: [],
          };
        }
        sizes.push(total);
        next = total > 70_000 && next < 15_000 ? 15_000 : 4_000;
        return step++ < 22
          ? {
              content: [
                {
                  type: 'tool-call' as const,
                  toolCallId: `large-${step}`,
                  toolName: 'large_result',
                  input: '{}',
                },
              ],
              finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
              usage,
              warnings: [],
            }
          : {
              content: [{ type: 'text' as const, text: 'Done.' }],
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage,
              warnings: [],
            };
      },
    });
    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    const phases = (await services.lifecycle.checkpoints(profile.id, run.id)).map(
      (checkpoint) => checkpoint.data as { phase?: string; via?: string },
    );
    const compacted = phases.find((data) => data.phase === 'context-compacted') as
      | { via?: string; beforeTokens?: number }
      | undefined;
    // The request it compacted had grown past what fits at the hard edge, 90,000 / 1.15.
    expect(compacted?.beforeTokens).toBeGreaterThan(90_000 / 1.15);
    expect(phases.filter((data) => data.phase === 'context-truncated')).toEqual([]);
    expect(compacted?.via).toBe('request');
  });
});

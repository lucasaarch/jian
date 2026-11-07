import { randomUUID } from 'node:crypto';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { and, eq, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { insertMessage } from '../src/sessions/repository.js';
import { checkpoints } from '../src/storage/schema.js';
import {
  addedIn,
  type ClaudeReply,
  type ClaudeRequest,
  fakeClaude,
  isSummary,
} from './helpers/claude.js';
import { isSummary as asksForSummary } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const MODEL = 'claude-opus-5-5';
const HOUR = 60 * 60_000;

/** A Claude conversation, at the owner's effort, with older turns worth summarising. */
async function conversation(
  contextPolicy?: Record<string, number>,
  turns = 6,
  size = 300,
  modelId = MODEL,
) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: {
      provider: 'anthropic',
      modelId,
      reasoningEffort: 'high',
      apiKeyEnv: 'JIAN_PROVIDER_TEST',
    },
    ...(contextPolicy ? { contextPolicy } : {}),
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Release' });
  for (let index = 0; index < turns; index++) {
    await insertMessage(services.store.db, {
      id: randomUUID(),
      profileId: profile.id,
      sessionId: session.id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${index} ${'history '.repeat(size)}`,
      createdAt: new Date(Date.parse('2026-11-01T09:00:00.000Z') + index * 1000).toISOString(),
    });
  }
  const ask = (text: string) =>
    services.runs.submit(profile.id, session.id, { text, requestKey: randomUUID() });
  return { services, profile, session, ask };
}

const summaries = (requests: ClaudeRequest[]) => requests.filter(isSummary);

/** Asks for compact_context mid-turn, then answers; `summary` is what the summary call gets. */
function compactingClaude(
  summary: ClaudeReply | ((request: ClaudeRequest) => ClaudeReply),
  modelId = MODEL,
) {
  const plan: ClaudeReply[] = [
    { tool: 'load_tools', input: { groups: ['tasks'] } },
    { tool: 'compact_context' },
    { text: 'Carried on.' },
  ];
  let step = 0;
  return fakeClaude(modelId, (request) =>
    isSummary(request)
      ? typeof summary === 'function'
        ? summary(request)
        : summary
      : (plan[step++] ?? { text: 'Done.' }),
  );
}

const phases = async (
  services: Awaited<ReturnType<typeof testServices>>,
  profileId: string,
  runId: string,
) =>
  (await services.lifecycle.checkpoints(profileId, runId)).map(
    (checkpoint) => checkpoint.data as Record<string, unknown>,
  );

it.each([
  // Takes an effort of its own for one reply: the summary is asked for at low effort.
  ['claude-opus-5-5', true],
  // Does not: the summary keeps the conversation's effort, which its cached messages need.
  ['claude-opus-4-8', false],
])('summarises with the request the conversation just sent (%s)', async (modelId, lowered) => {
  const { services, profile, session, ask } = await conversation(undefined, 6, 300, modelId);
  const run = await ask('Carry on with the release.');
  const claude = compactingClaude(
    { text: '## Open request\nCarry on with the release.', cacheRead: 9_000 },
    modelId,
  );

  await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).output).toBe('Carried on.');
  const [summary] = summaries(claude.requests);
  if (!summary) throw new Error('No summary was asked for');
  const before = claude.requests[claude.requests.indexOf(summary) - 1];
  expect(before?.stream).toBe(true);
  expect(isSummary(before)).toBe(false);
  // Anthropic caches tools, then system, then messages: one byte different in any of them, or
  // in the thinking, the effort or tool_choice, and the summary reads it all again uncached.
  for (const field of [
    'tools',
    'system',
    'thinking',
    'output_config',
    'tool_choice',
    'max_tokens',
    'stream',
  ] as const) {
    expect(JSON.stringify(summary[field]), field).toBe(JSON.stringify(before?.[field]));
  }
  expect(summary.output_config).toMatchObject({ effort: 'high' });
  expect(summary.tools?.length).toBeGreaterThan(0);
  // After the shared prefix: the step's last message with the ask joined to it, then, where the
  // model takes one, a system message that sets the effort of this one reply and nothing else.
  const tail = lowered ? 2 : 1;
  expect(summary.messages).toHaveLength((before?.messages.length ?? 0) + tail - 1);
  expect(JSON.stringify(summary.messages.slice(0, -tail))).toBe(
    JSON.stringify(before?.messages.slice(0, -1)),
  );
  if (lowered) {
    expect(summary.messages.at(-1)).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'low' },
    });
    expect(summary.beta?.split(',')).toEqual(
      expect.arrayContaining([
        ...(before?.beta?.split(',') ?? []),
        'mid-conversation-effort-2026-08-01',
      ]),
    );
  } else {
    expect(summary.beta).toBe(before?.beta);
  }
  // The step's last message, its cache mark where it was, and then the summary instructions,
  // unmarked.
  const last = summary.messages.at(-tail);
  const sent = before?.messages.at(-1);
  expect(last?.role).toBe('user');
  if (typeof last?.content === 'string' || typeof sent?.content === 'string') {
    throw new Error('Expected content blocks');
  }
  expect(JSON.stringify(last?.content.slice(0, -1))).toBe(JSON.stringify(sent?.content));
  const ask_ = last?.content.at(-1) as { type: string; text?: string; cache_control?: unknown };
  expect(ask_.type).toBe('text');
  expect(ask_.text).toMatch(/^Respond with text only\. Do not call any tools\./);
  expect(ask_.text).toContain('2,500 words');
  expect(ask_.text).toContain('in their words');
  expect(ask_.cache_control).toBeUndefined();

  // The record replaced the older turns, and the owner can see what the cache took.
  const compacted = (await phases(services, profile.id, run.id)).find(
    (data) => data.phase === 'context-compacted',
  );
  expect(compacted?.usage).toMatchObject({ cachedInputTokens: 9_000 });
  expect((await services.sessions.session(profile.id, session.id)).summary).toContain(
    'Carry on with the release.',
  );
  const after = claude.requests.at(-1);
  expect(JSON.stringify(after?.messages)).toContain('Conversation checkpoint');
  // The older turns are gone as turns: what people wrote in them stays only beside the record,
  // and what the agent answered is not kept at all.
  expect(JSON.stringify(after?.messages.slice(1))).not.toContain('turn-0 ');
  expect(JSON.stringify(after?.messages)).not.toContain('turn-1 ');
});

it('a summary that calls a tool fails without running it', async () => {
  const { services, profile, session, ask } = await conversation();
  const run = await ask('Carry on with the release.');
  const claude = compactingClaude({
    tool: 'remember',
    input: { key: 'release', content: 'Written by a summary.', expectedVersion: 0 },
  });

  await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).output).toBe('Carried on.');
  expect(await services.memories.memories(profile.id)).toEqual([]);
  const data = await phases(services, profile.id, run.id);
  expect(data.some((item) => item.phase === 'tool-started' && item.toolName === 'remember')).toBe(
    false,
  );
  expect(data.find((item) => item.phase === 'compaction-failed')?.reason).toMatch(/called a tool/);
  expect((await services.sessions.session(profile.id, session.id)).summary).toBeUndefined();
});

it('falls back to segments when the prompt is past the window', async () => {
  // Some 48,000 of Claude's tokens of history, at the half a token it starts from, in a window
  // of 32,000: the request the conversation would send does not fit, so nothing can be reused.
  const { services, profile, ask } = await conversation(
    { inputTokens: 32_000, outputTokens: 1_024 },
    12,
    1_000,
  );
  const run = await ask('Carry on with the release.');
  const claude = fakeClaude(MODEL, (request) =>
    isSummary(request) ? { text: '## Open request\nThe release.' } : { text: 'Carried on.' },
  );

  await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).output).toBe('Carried on.');
  const sent = summaries(claude.requests);
  expect(sent.length).toBeGreaterThan(0);
  for (const summary of sent) {
    expect(summary.tools ?? []).toEqual([]);
    expect(JSON.stringify(summary.system)).toContain('Read the next conversation segment');
  }
});

it('summarises /compact with the request the conversation sends', async () => {
  const { services, profile, ask } = await conversation();
  const claude = fakeClaude(MODEL, (request) =>
    isSummary(request) ? { text: '## Open request\nNone' } : { text: 'Answered.' },
  );
  const first = await ask('What is left for the release?');
  await new AgentRuntime(services, () => claude.model).execute(profile.id, first.id);
  const previous = claude.requests.at(-1);

  const command = await services.runs.submit(
    profile.id,
    (await services.runs.run(profile.id, first.id)).sessionId,
    { text: '/compact', requestKey: 'compact' },
    { ownerMessage: true },
  );
  await new AgentRuntime(services, () => claude.model).execute(profile.id, command.id);

  const [summary] = summaries(claude.requests);
  if (!summary) throw new Error('No summary was asked for');
  // A turn later, the front of the prompt is still the one the last turn wrote to the cache.
  for (const field of ['tools', 'system', 'thinking', 'output_config'] as const) {
    expect(JSON.stringify(summary[field]), field).toBe(JSON.stringify(previous?.[field]));
  }
  // The ask, then the message that sets the effort of this one reply.
  const [ask_, effort] = summary.messages.slice(-2);
  expect(JSON.stringify(ask_)).toContain('Respond with text only. Do not call any tools.');
  expect(effort).toMatchObject({ role: 'system', output_config: { effort: 'low' } });
  expect((await services.runs.run(profile.id, command.id)).status).toBe('completed');
  // The command's own answer still offers no tools.
  expect(claude.requests.at(-1)?.tools ?? []).toEqual([]);
});

it('summarises a turn whose cache has expired in segments', async () => {
  const { services, profile, session, ask } = await conversation();
  const claude = fakeClaude(MODEL, (request) =>
    isSummary(request) ? { text: '## Open request\nNone' } : { text: 'Answered.' },
  );
  const first = await ask('What is left for the release?');
  await new AgentRuntime(services, () => claude.model).execute(profile.id, first.id);
  // The last step is two hours old: past the hour an owner's conversation is cached for, so
  // the request it wrote is gone, and sending it again would write all of it to the cache.
  const sentAt = new Date(Date.now() - 2 * HOUR);
  await services.store.db
    .update(checkpoints)
    .set({
      createdAt: sentAt,
      data: sql`jsonb_set(${checkpoints.data}, '{prompt,sentAt}', to_jsonb(${sentAt.toISOString()}::text))`,
    })
    .where(and(eq(checkpoints.runId, first.id), sql`${checkpoints.data} ? 'prompt'`));
  const before = claude.requests.length;

  const command = await services.runs.submit(
    profile.id,
    session.id,
    { text: '/compact', requestKey: 'compact-late' },
    { ownerMessage: true },
  );
  await new AgentRuntime(services, () => claude.model).execute(profile.id, command.id);

  const sent = summaries(claude.requests.slice(before));
  expect(sent.length).toBeGreaterThan(0);
  for (const summary of sent) {
    expect(summary.tools ?? []).toEqual([]);
    expect(JSON.stringify(summary.system)).toContain('Read the next conversation segment');
  }
  expect((await services.runs.run(profile.id, command.id)).status).toBe('completed');
});

it('summarises a large conversation whose cache expired in place, writing nothing to the cache', async () => {
  // Some 290,000 tokens at the half a token a byte Claude starts from: more than two segments.
  const { services, profile, session, ask } = await conversation(
    { inputTokens: 1_000_000, outputTokens: 64_000 },
    6,
    12_000,
  );
  const claude = fakeClaude(MODEL, (request) =>
    isSummary(request) ? { text: '## Open request\nNone' } : { text: 'Answered.' },
  );
  const first = await ask('What is left for the release?');
  await new AgentRuntime(services, () => claude.model).execute(profile.id, first.id);
  const sentAt = new Date(Date.now() - 2 * HOUR);
  await services.store.db
    .update(checkpoints)
    .set({
      createdAt: sentAt,
      data: sql`jsonb_set(${checkpoints.data}, '{prompt,sentAt}', to_jsonb(${sentAt.toISOString()}::text))`,
    })
    .where(and(eq(checkpoints.runId, first.id), sql`${checkpoints.data} ? 'prompt'`));
  const before = claude.requests.length;

  const command = await services.runs.submit(
    profile.id,
    session.id,
    { text: '/compact', requestKey: 'compact-cold' },
    { ownerMessage: true },
  );
  await new AgentRuntime(services, () => claude.model).execute(profile.id, command.id);

  const sent = summaries(claude.requests.slice(before));
  expect(sent).toHaveLength(1);
  const [summary] = sent;
  // The conversation's own request, tools and system as cached before, its messages unmarked:
  // the checkpoint replaces them, so a write of them would never be read.
  expect(summary?.tools?.length).toBeGreaterThan(0);
  expect(JSON.stringify(summary?.system)).toContain('cache_control');
  expect(JSON.stringify(summary?.messages)).not.toContain('cache_control');
  const compacted = (await phases(services, profile.id, command.id)).find(
    (data) => data.phase === 'context-compacted',
  );
  expect(compacted?.via).toBe('request');
});

it('falls back to segments when the provider refuses the summary sent in place', async () => {
  const { services, profile, session, ask } = await conversation();
  const run = await ask('Carry on with the release.');
  // Sent in place, the summary carries the run's tools; read in segments, none.
  const claude = compactingClaude((request) =>
    request.tools?.length
      ? { refuse: 'Synthetic refusal of the summary request.' }
      : { text: '## Open request\nCarry on with the release.' },
  );
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  let said: string[];
  try {
    await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);
  } finally {
    said = logged.mock.calls.map((call) => String(call[0]));
    logged.mockRestore();
  }

  expect((await services.runs.run(profile.id, run.id)).output).toBe('Carried on.');
  const data = await phases(services, profile.id, run.id);
  const compacted = data.find((item) => item.phase === 'context-compacted');
  expect(compacted?.via).toBe('segments');
  expect(compacted?.inPlaceRefused).toContain('Synthetic refusal of the summary request.');
  // One line for the operator: the model and what the provider said, not the conversation.
  const lines = said.filter((line) => line.includes('summary in place refused'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(MODEL);
  expect(lines[0]).toContain('Synthetic refusal of the summary request.');
  expect(lines[0]).not.toContain('history');
  expect(data.some((item) => item.phase === 'compaction-failed')).toBe(false);
  expect((await services.sessions.session(profile.id, session.id)).summary).toContain(
    'Carry on with the release.',
  );
});

it.each([
  ['sent in place', ['load_tools', 'compact_context'], undefined],
  // Past the window: the older turns are read in segments, each its own long call.
  ['read in segments', [], { inputTokens: 32_000, outputTokens: 1_024 }],
] as const)(
  'keeps a run alive while its summary is still streaming, %s',
  async (_, plan, policy) => {
    const { services, profile, ask } = await conversation(
      policy,
      policy ? 12 : 6,
      policy ? 1_000 : 300,
    );
    const run = await ask('Carry on with the release.');
    let step = 0;
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 10, text: 10, reasoning: 0 },
    };
    const finish = (finishReason: 'stop' | 'tool-calls') => ({
      type: 'finish' as const,
      finishReason: { unified: finishReason, raw: finishReason },
      usage,
    });
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (asksForSummary(options)) {
          // A long record: something comes back every 250 ms for nearly twice the stall window,
          // which would otherwise read as a call that is not coming back.
          const deltas = Array.from({ length: 16 }, (_, index) => ({
            type: 'text-delta' as const,
            id: 'record',
            delta: index ? ' and more' : '## Open request\nCarry on with the release.',
          }));
          return {
            stream: simulateReadableStream({
              chunkDelayInMs: 250,
              chunks: [
                { type: 'stream-start' as const, warnings: [] },
                { type: 'text-start' as const, id: 'record' },
                ...deltas,
                { type: 'text-end' as const, id: 'record' },
                finish('stop'),
              ],
            }),
          };
        }
        const name = plan[step];
        step++;
        const chunks: unknown[] = name
          ? [
              { type: 'stream-start' as const, warnings: [] },
              {
                type: 'tool-call' as const,
                toolCallId: `call-${step}`,
                toolName: name,
                input: JSON.stringify(name === 'load_tools' ? { groups: ['tasks'] } : {}),
              },
              finish('tool-calls'),
            ]
          : [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: 'answer' },
              { type: 'text-delta' as const, id: 'answer', delta: 'Carried on.' },
              { type: 'text-end' as const, id: 'answer' },
              finish('stop'),
            ];
        // The parts' types are the provider spec's, which this workspace does not import.
        return { stream: simulateReadableStream({ chunks }) } as never;
      },
    });

    await new AgentRuntime(services, () => model, { stalledAfterMs: 2_500 }).execute(
      profile.id,
      run.id,
    );

    const finished = await services.runs.run(profile.id, run.id);
    expect(finished.error).toBeUndefined();
    expect(finished.output).toBe('Carried on.');
    const compacted = (await phases(services, profile.id, run.id)).find(
      (data) => data.phase === 'context-compacted',
    );
    expect(compacted?.via).toBe(policy ? 'segments' : 'request');
  },
  20_000,
);

it('summarises /compact with the tools an earlier turn loaded, as that turn cached them', async () => {
  const { services, profile, session, ask } = await conversation();
  let plan: ClaudeReply[] = [
    { tool: 'load_tools', input: { groups: ['conversations'] } },
    { text: 'Loaded.' },
  ];
  let step = 0;
  const claude = fakeClaude(MODEL, (request) =>
    isSummary(request) ? { text: '## Open request\nNone' } : (plan[step++] ?? { text: 'Done.' }),
  );
  const first = await ask('Load what you need to see my conversations.');
  await new AgentRuntime(services, () => claude.model).execute(profile.id, first.id);
  const previous = claude.requests.at(-1);
  plan = [{ text: 'Compacted.' }];
  step = 0;

  const command = await services.runs.submit(
    profile.id,
    session.id,
    { text: '/compact', requestKey: 'compact-carried' },
    { ownerMessage: true },
  );
  await new AgentRuntime(services, () => claude.model).execute(profile.id, command.id);

  const [summary] = summaries(claude.requests);
  if (!summary) throw new Error('No summary was asked for');
  // The front of the prompt is the one the last turn wrote: the loaded tools still deferred.
  for (const field of ['tools', 'system', 'thinking', 'output_config'] as const) {
    expect(JSON.stringify(summary[field]), field).toBe(JSON.stringify(previous?.[field]));
  }
  // Last, one system message brings the loaded tools back and sets this reply's effort.
  const last = summary.messages.at(-1);
  expect(last?.role).toBe('system');
  expect(last?.output_config).toEqual({ effort: 'low' });
  const added = addedIn({ ...summary, messages: [last as ClaudeRequest['messages'][number]] });
  expect(added.length).toBeGreaterThan(0);
  expect(added).toEqual(addedIn(summary));
  expect(JSON.stringify(summary.messages.at(-2))).toContain('Respond with text only.');
  expect((await services.runs.run(profile.id, command.id)).status).toBe('completed');
});

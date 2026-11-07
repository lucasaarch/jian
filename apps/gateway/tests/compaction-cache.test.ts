import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { insertMessage } from '../src/sessions/repository.js';
import { type ClaudeReply, type ClaudeRequest, fakeClaude, isSummary } from './helpers/claude.js';
import { testServices } from './helpers/services.js';

const MODEL = 'claude-opus-5-5';

/** A Claude conversation, at the owner's effort, with older turns worth summarising. */
async function conversation(contextPolicy?: Record<string, number>, turns = 6, size = 300) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: {
      provider: 'anthropic',
      modelId: MODEL,
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
function compactingClaude(summary: ClaudeReply) {
  const plan: ClaudeReply[] = [
    { tool: 'load_tools', input: { groups: ['tasks'] } },
    { tool: 'compact_context' },
    { text: 'Carried on.' },
  ];
  let step = 0;
  return fakeClaude(MODEL, (request) =>
    isSummary(request) ? summary : (plan[step++] ?? { text: 'Done.' }),
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

it('summarises with the request the conversation just sent', async () => {
  const { services, profile, session, ask } = await conversation();
  const run = await ask('Carry on with the release.');
  const claude = compactingClaude({
    text: '## Open request\nCarry on with the release.',
    cacheRead: 9_000,
  });

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
    'beta',
  ] as const) {
    expect(JSON.stringify(summary[field]), field).toBe(JSON.stringify(before?.[field]));
  }
  expect(summary.output_config).toMatchObject({ effort: 'high' });
  expect(summary.tools?.length).toBeGreaterThan(0);
  expect(JSON.stringify(summary.messages.slice(0, -1))).toBe(
    JSON.stringify(before?.messages.slice(0, -1)),
  );
  // The last message is the one the step ended on, its cache mark where it was, and then the
  // summary instructions, unmarked.
  const last = summary.messages.at(-1);
  const sent = before?.messages.at(-1);
  expect(last?.role).toBe('user');
  if (typeof last?.content === 'string' || typeof sent?.content === 'string') {
    throw new Error('Expected content blocks');
  }
  expect(JSON.stringify(last?.content.slice(0, -1))).toBe(JSON.stringify(sent?.content));
  const ask_ = last?.content.at(-1) as { type: string; text?: string; cache_control?: unknown };
  expect(ask_.type).toBe('text');
  expect(ask_.text).toMatch(/^Respond with text only\. Do not call any tools\./);
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
  expect(JSON.stringify(after?.messages)).not.toContain('turn-0 ');
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
    expect(summary.stream).not.toBe(true);
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
  const last = summary.messages.at(-1);
  expect(JSON.stringify(last)).toContain('Respond with text only. Do not call any tools.');
  expect((await services.runs.run(profile.id, command.id)).status).toBe('completed');
  // The command's own answer still offers no tools.
  expect(claude.requests.at(-1)?.tools ?? []).toEqual([]);
});

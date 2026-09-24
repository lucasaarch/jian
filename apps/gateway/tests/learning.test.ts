import { LEARNING_SESSION_CHANNEL } from '@jian/contracts';
import { expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

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
const readMemories = (id: string) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName: 'read_memories', input: '{}' }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
  usage,
  warnings: [],
});

async function profileWith(learnFromWork = true) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    allowShell: true,
    learnFromWork,
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Work' });

  return { services, profile, session };
}

/** A turn that calls `read_memories` this many times, then answers. */
async function turn(
  f: Awaited<ReturnType<typeof profileWith>>,
  toolCalls: number,
  requestKey: string,
) {
  const run = await f.services.runs.submit(f.profile.id, f.session.id, {
    text: 'Prepare the weekly report',
    requestKey,
  });
  let step = 0;
  const model = mockModel({
    doGenerate: async () =>
      step++ < toolCalls ? readMemories(`${requestKey}-${step}`) : answer('Report ready.'),
  });

  await new AgentRuntime(f.services, () => model).execute(f.profile.id, run.id);

  return run;
}

const looks = async (f: Awaited<ReturnType<typeof profileWith>>) => {
  const learning = (await f.services.sessions.sessions(f.profile.id)).find(
    (session) => session.channel === LEARNING_SESSION_CHANNEL,
  );

  return learning
    ? (await f.services.runs.recent(f.profile.id)).filter((run) => run.sessionId === learning.id)
    : [];
};

it('looks back on a turn that did a lot of work, once, with only memories and skills', async () => {
  const f = await profileWith();

  await turn(f, 2, 'small');
  expect(await looks(f)).toEqual([]);

  await turn(f, 10, 'big');
  const [look] = await looks(f);

  expect(look?.input).toMatch(/^\[Learning\] Looking back at a turn with 10 tool calls/);
  expect(look?.input).toContain('Tools, in order: read_memories');

  // Another big turn within the cooldown is not looked back on again.
  await turn(f, 12, 'bigger');
  expect(await looks(f)).toHaveLength(1);

  // The look back itself sees memory and skill tools only, and asks for no further look.
  let offered: string[] = [];
  const reviewer = mockModel({
    doGenerate: async (options) => {
      offered = (options.tools ?? []).map((tool) => tool.name);

      return answer('Nothing to keep.');
    },
  });

  await new AgentRuntime(f.services, () => reviewer).execute(f.profile.id, look?.id as string);

  expect((await f.services.runs.run(f.profile.id, look?.id as string)).status).toBe('completed');
  expect(offered).toContain('create_skill');
  expect(offered).toContain('remember');
  expect(offered).not.toContain('run_command');
  expect(offered).not.toContain('send_session_message');
  expect(await looks(f)).toHaveLength(1);
});

it('never looks back when the owner switched learning off', async () => {
  const f = await profileWith(false);

  await turn(f, 12, 'big');

  expect(await looks(f)).toEqual([]);
  expect(
    (await f.services.sessions.sessions(f.profile.id)).some(
      (session) => session.channel === LEARNING_SESSION_CHANNEL,
    ),
  ).toBe(false);
});

it('tells the agent how full its context is when the turn starts', async () => {
  const f = await profileWith();
  const run = await f.services.runs.submit(f.profile.id, f.session.id, {
    text: 'Hello',
    requestKey: 'context',
  });
  const { system } = await f.services.contexts.context(run);

  expect(system).toMatch(/Context: this turn starts at about [\d,]+ of 32,000 tokens \(\d+%\)/);
});

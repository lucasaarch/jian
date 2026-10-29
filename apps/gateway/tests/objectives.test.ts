import { MAX_OBJECTIVE_TEXT } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import {
  looksLikeObjectiveDump,
  MAX_OBJECTIVE_CONTINUATIONS,
  MAX_OBJECTIVE_CONTINUE_SUMMARY,
  objectiveContinuePrompt,
  parseObjectiveCommand,
  sanitizeObjectiveText,
} from '../src/sessions/objective.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

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

const TERMINAL_DUMP = [
  'Last login: Tue Oct 20 20:34:42 on ttys001',
  'lucas@host ~ % curl -fsSL https://example.com/update | bash',
  'node:internal/modules/esm/get_format:218',
  '  throw new ERR_UNKNOWN_FILE_EXTENSION(ext, filepath)',
  '  ^',
  "TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension '.ts'",
  '    at Object.getFileProtocolModuleFormat [as getFormat] (node:internal/modules/esm/get_format:218:9)',
  '    at defaultGetFormat (node:internal/modules/esm/get_format:244:36)',
].join('\n');

describe('objective commands', () => {
  it('parses set, done and cancel forms', () => {
    expect(parseObjectiveCommand('/objective Clone the Jian repository and open a PR')).toEqual({
      action: 'set',
      text: 'Clone the Jian repository and open a PR',
    });
    expect(parseObjectiveCommand('/done')).toEqual({ action: 'done' });
    expect(parseObjectiveCommand('/objective done')).toEqual({ action: 'done' });
    expect(parseObjectiveCommand('/objective cancel')).toEqual({ action: 'cancel' });
    expect(parseObjectiveCommand('/cancel objective')).toEqual({ action: 'cancel' });
    expect(parseObjectiveCommand('/ponytail')).toBeUndefined();
  });
});

describe('objective text sanitization', () => {
  it(`caps durable goals at ${MAX_OBJECTIVE_TEXT} characters`, () => {
    const long = `Ship the approved feature ${'x'.repeat(MAX_OBJECTIVE_TEXT)}`;
    const cleaned = sanitizeObjectiveText(long);
    expect(cleaned.length).toBeLessThanOrEqual(MAX_OBJECTIVE_TEXT);
    expect(cleaned.startsWith('Ship the approved feature')).toBe(true);
  });

  it('rejects terminal dumps instead of storing them as the goal', () => {
    expect(looksLikeObjectiveDump(TERMINAL_DUMP)).toBe(true);
    const cleaned = sanitizeObjectiveText(TERMINAL_DUMP);
    expect(cleaned).toBe('Continue prior open work');
    expect(cleaned).not.toContain('Last login:');
    expect(cleaned).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
    expect(cleaned.length).toBeLessThanOrEqual(MAX_OBJECTIVE_TEXT);
  });

  it('keeps a short goal line when a dump also carries one', () => {
    const mixed = `Fix the remote worker install on Lucas’s laptop\n${TERMINAL_DUMP}`;
    expect(sanitizeObjectiveText(mixed)).toBe('Fix the remote worker install on Lucas’s laptop');
  });

  it('shapes continue prompts around a short Goal summary', () => {
    const prompt = objectiveContinuePrompt(TERMINAL_DUMP);
    expect(prompt).toContain('Continue the open session objective');
    expect(prompt).toContain('Goal: Continue prior open work');
    expect(prompt).not.toContain('Objective:');
    expect(prompt).not.toContain('Last login:');
    expect(prompt).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
    const goal = prompt.match(/Goal: (.+?) Take the next/)?.[1] ?? '';
    expect(goal.length).toBeGreaterThan(0);
    expect(goal.length).toBeLessThanOrEqual(MAX_OBJECTIVE_CONTINUE_SUMMARY);
  });
});

it('persists an owner objective across turns and completes explicitly', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });

  await services.runs.submit(
    profile.id,
    session.id,
    {
      text: '/objective Implement voice calls end to end with tests',
      requestKey: 'set-objective',
    },
    { ownerMessage: true },
  );

  const open = await services.sessions.session(profile.id, session.id);
  expect(open.objective).toMatchObject({
    text: 'Implement voice calls end to end with tests',
    status: 'open',
    continuations: 0,
  });

  await services.runs.submit(
    profile.id,
    session.id,
    { text: '/done', requestKey: 'done-objective' },
    { ownerMessage: true },
  );
  expect((await services.sessions.session(profile.id, session.id)).objective).toMatchObject({
    status: 'done',
    text: 'Implement voice calls end to end with tests',
  });
});

it('does not auto-seed an objective from casual or task-shaped chat', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const panel = await services.sessions.createSession(profile.id, { channel: 'api' });
  const channel = await services.sessions.createSession(profile.id, { channel: 'whatsapp' });

  const casual =
    'que pena, gostaria de ver uma continuação daquele cliffhanger da série que paramos ontem à noite';
  await services.runs.submit(
    profile.id,
    panel.id,
    { text: casual, requestKey: 'casual-panel' },
    { ownerMessage: true },
  );
  expect((await services.sessions.session(profile.id, panel.id)).objective ?? null).toBeNull();

  await services.runs.submit(
    profile.id,
    channel.id,
    {
      text: 'Clone the Jian repository over SSH and prepare a development branch for the voice work',
      requestKey: 'task-shaped-channel',
    },
    { activity: 'channel' },
  );
  expect((await services.sessions.session(profile.id, channel.id)).objective ?? null).toBeNull();
});

it('sets an objective from an explicit channel /objective command and cancels via the API', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'whatsapp' });

  await services.runs.submit(
    profile.id,
    session.id,
    {
      text: '/objective Clone the Jian repository over SSH and prepare a development branch',
      requestKey: 'explicit-objective',
    },
    { activity: 'channel' },
  );

  expect((await services.sessions.session(profile.id, session.id)).objective).toMatchObject({
    status: 'open',
    text: 'Clone the Jian repository over SSH and prepare a development branch',
  });

  const updated = await services.sessions.setObjective(profile.id, session.id, {
    status: 'cancelled',
    note: 'Owner changed plans',
  });
  expect(updated.objective).toMatchObject({ status: 'cancelled', note: 'Owner changed plans' });
});

it('keeps an open objective text when the owner chats again', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  await services.sessions.setObjective(profile.id, session.id, {
    text: 'Ship the approved voice-call feature',
    status: 'open',
  });

  await services.runs.submit(
    profile.id,
    session.id,
    {
      text: 'que pena, gostaria de ver uma continuação daquele cliffhanger da série',
      requestKey: 'chat-while-open',
    },
    { ownerMessage: true },
  );

  expect((await services.sessions.session(profile.id, session.id)).objective).toMatchObject({
    status: 'open',
    text: 'Ship the approved voice-call feature',
  });
});

it('keeps queuing follow-up runs until the objective is completed', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  await services.sessions.setObjective(profile.id, session.id, {
    text: 'Ship the approved voice-call feature',
    status: 'open',
  });

  const first = await services.runs.submit(profile.id, session.id, {
    text: 'Start the approved work',
    requestKey: 'first',
  });

  let calls = 0;
  const model = mockModel({
    doGenerate: async () => {
      calls++;
      if (calls === 1) {
        return {
          content: [
            { type: 'text', text: 'Starting the credentials slice.' },
            {
              type: 'tool-call',
              toolCallId: 'list',
              toolName: 'list_activities',
              input: '{}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }
      return answer('Credentials slice done; more remains.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, first.id);
  expect((await services.runs.run(profile.id, first.id)).status).toBe('completed');

  const afterFirst = await services.sessions.session(profile.id, session.id);
  expect(afterFirst.objective).toMatchObject({ status: 'open', continuations: 1 });

  const followUps = (await services.runs.activities(profile.id)).filter(
    (run) => run.id !== first.id && run.status === 'queued',
  );
  expect(followUps).toHaveLength(1);
  expect(followUps[0]?.input).toContain('Continue the open session objective');
  expect(followUps[0]?.input).toContain('Goal: Ship the approved voice-call feature');
  expect(followUps[0]?.input).not.toContain('Objective:');

  let secondCalls = 0;
  const finishing = mockModel({
    doGenerate: async () => {
      secondCalls++;
      if (secondCalls === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'done',
              toolName: 'complete_session_objective',
              input: JSON.stringify({ note: 'All slices landed' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }
      return answer('Voice calls are implemented.');
    },
  });

  const followUp = followUps[0];
  expect(followUp).toBeDefined();
  if (!followUp) throw new Error('expected objective follow-up run');
  await new AgentRuntime(services, () => finishing).execute(profile.id, followUp.id);
  expect((await services.sessions.session(profile.id, session.id)).objective).toMatchObject({
    status: 'done',
    note: 'All slices landed',
  });
  expect(
    (await services.runs.activities(profile.id)).filter((run) => run.status === 'queued'),
  ).toEqual([]);
});

it('auto-continue does not reinject a stored terminal dump as the wake text', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  // Simulate a pre-cap row that still holds a dump in jsonb (bypasses write sanitization).
  await services.sessions.writeObjective(profile.id, session.id, {
    text: TERMINAL_DUMP,
    status: 'open',
    updatedAt: new Date().toISOString(),
    continuations: 0,
  });

  const first = await services.runs.submit(profile.id, session.id, {
    text: 'Keep going',
    requestKey: 'dump-continue',
  });
  const model = mockModel({
    doGenerate: async () => answer('Another slice.'),
  });
  await new AgentRuntime(services, () => model).execute(profile.id, first.id);

  const followUps = (await services.runs.activities(profile.id)).filter(
    (run) => run.id !== first.id && run.status === 'queued',
  );
  expect(followUps).toHaveLength(1);
  const wake = followUps[0]?.input ?? '';
  expect(wake).toContain('Continue the open session objective');
  expect(wake).toContain('Goal:');
  expect(wake).not.toContain('Last login:');
  expect(wake).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
  expect(wake).not.toContain('node:internal');
  expect(wake.length).toBeLessThan(600);

  const stored = await services.sessions.session(profile.id, session.id);
  expect(stored.objective?.text).not.toContain('Last login:');
  expect(stored.objective?.text.length).toBeLessThanOrEqual(MAX_OBJECTIVE_TEXT);
});

it('caps oversized objective writes to a short durable goal', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  const long = `Implement the full voice stack end to end ${'detail '.repeat(80)}`;
  const updated = await services.sessions.setObjective(profile.id, session.id, {
    text: long,
    status: 'open',
  });
  expect(updated.objective?.text.length).toBeLessThanOrEqual(MAX_OBJECTIVE_TEXT);
  expect(updated.objective?.text.startsWith('Implement the full voice stack')).toBe(true);
});

it('blocks on the owner and reopens when they reply', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, {
    channel: 'api',
    title: 'Provider',
  });
  await services.sessions.setObjective(profile.id, session.id, {
    text: 'Choose a Live API provider',
    status: 'open',
  });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Need a decision',
    requestKey: 'block',
  });

  let step = 0;
  const model = mockModel({
    doGenerate: async () => {
      step++;
      if (step === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'block',
              toolName: 'block_session_objective',
              input: JSON.stringify({ note: 'Which provider should I wire first?' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }
      return answer('Waiting on your provider choice.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.sessions.session(profile.id, session.id)).objective).toMatchObject({
    status: 'blocked',
    note: 'Which provider should I wire first?',
  });
  expect((await services.runs.activities(profile.id)).filter((r) => r.status === 'queued')).toEqual(
    [],
  );

  await services.runs.submit(
    profile.id,
    session.id,
    {
      text: 'que pena, gostaria de ver uma continuação — ainda estou pensando no provedor',
      requestKey: 'reply',
    },
    { ownerMessage: true },
  );
  expect((await services.sessions.session(profile.id, session.id)).objective).toMatchObject({
    status: 'open',
    text: 'Choose a Live API provider',
  });
});

it('isolates objectives between profiles', async () => {
  const services = await testServices();
  const a = await services.profiles.createProfile(input);
  const b = await services.profiles.createProfile({ ...input, name: 'Other' });
  const session = await services.sessions.createSession(a.id, { channel: 'api' });
  await services.sessions.setObjective(a.id, session.id, {
    text: 'Private work',
    status: 'open',
  });

  await expect(
    services.sessions.setObjective(b.id, session.id, { status: 'done' }),
  ).rejects.toMatchObject({
    statusCode: 404,
  });
  expect((await services.sessions.session(a.id, session.id)).objective?.status).toBe('open');
});

it(`pauses after ${MAX_OBJECTIVE_CONTINUATIONS} automatic continuations`, async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  await services.sessions.writeObjective(profile.id, session.id, {
    text: 'Endless work',
    status: 'open',
    updatedAt: new Date().toISOString(),
    continuations: MAX_OBJECTIVE_CONTINUATIONS,
  });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Keep going',
    requestKey: 'cap',
  });
  const model = mockModel({
    doGenerate: async () => answer('Another slice.'),
  });
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  expect((await services.sessions.session(profile.id, session.id)).objective).toMatchObject({
    status: 'blocked',
  });
  expect((await services.runs.activities(profile.id)).filter((r) => r.status === 'queued')).toEqual(
    [],
  );
});

it('injects the open objective into the prompt', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  await services.sessions.setObjective(profile.id, session.id, {
    text: 'Finish the WhatsApp loop fix',
    status: 'open',
  });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Go',
    requestKey: 'ctx',
  });
  const context = await services.contexts.context(run, []);
  expect(context.system).toContain('Finish the WhatsApp loop fix');
  expect(context.system).toContain('complete_session_objective');
});

it('prompt injection sanitizes a dump-shaped objective', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  await services.sessions.writeObjective(profile.id, session.id, {
    text: TERMINAL_DUMP,
    status: 'open',
    updatedAt: new Date().toISOString(),
    continuations: 0,
  });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Go',
    requestKey: 'ctx-dump',
  });
  const context = await services.contexts.context(run, []);
  expect(context.system).not.toContain('Last login:');
  expect(context.system).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
  expect(context.system).toContain('Continue prior open work');
});

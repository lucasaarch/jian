import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import {
  MAX_OBJECTIVE_CONTINUATIONS,
  parseObjectiveCommand,
  shouldSeedObjective,
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

  it('seeds only substantial requests', () => {
    expect(shouldSeedObjective('ok')).toBe(false);
    expect(shouldSeedObjective('Continua')).toBe(false);
    expect(
      shouldSeedObjective(
        'Clone github.com/lucasaarch/jian over SSH and set up the local development stack',
      ),
    ).toBe(true);
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

it('auto-seeds from a substantial channel message and cancels via the API', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'whatsapp' });

  await services.runs.submit(
    profile.id,
    session.id,
    {
      text: 'Clone the Jian repository over SSH and prepare a development branch for the voice work',
      requestKey: 'seed',
    },
    { activity: 'channel' },
  );

  expect((await services.sessions.session(profile.id, session.id)).objective?.status).toBe('open');

  const updated = await services.sessions.setObjective(profile.id, session.id, {
    status: 'cancelled',
    note: 'Owner changed plans',
  });
  expect(updated.objective).toMatchObject({ status: 'cancelled', note: 'Owner changed plans' });
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

it('blocks on the owner and reopens when they reply', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
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
    { text: 'Use Gemini Live', requestKey: 'reply' },
    { ownerMessage: true },
  );
  expect((await services.sessions.session(profile.id, session.id)).objective?.status).toBe('open');
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
  const context = await services.contexts.context(run);
  expect(context.system).toContain('Finish the WhatsApp loop fix');
  expect(context.system).toContain('complete_session_objective');
});

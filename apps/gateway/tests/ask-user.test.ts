import { expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
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

it('parks the run as waiting and resumes when the owner answers', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  await services.sessions.setObjective(profile.id, session.id, {
    text: 'Ship mid-run questions',
    status: 'open',
  });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Which provider first?',
    requestKey: 'ask',
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
              toolCallId: 'ask',
              toolName: 'ask_user',
              input: JSON.stringify({
                prompt: 'Which provider should I wire first?',
                choices: ['Continue', 'Cancel'],
              }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }
      return answer('Should not complete without an answer.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const parked = await services.runs.run(profile.id, run.id);
  expect(parked.status).toBe('waiting');
  expect(parked.question).toMatchObject({
    prompt: 'Which provider should I wire first?',
    choices: ['Continue', 'Cancel'],
  });
  expect(parked.leaseOwner).toBeUndefined();
  expect(
    (await services.runs.activities(profile.id)).filter((item) => item.status === 'queued'),
  ).toEqual([]);
  expect((await services.sessions.session(profile.id, session.id)).objective?.status).toBe('open');

  const resume = await services.runs.submit(
    profile.id,
    session.id,
    { text: 'Continue', requestKey: 'reply' },
    { ownerMessage: true },
  );

  expect(resume.status).toBe('queued');
  expect(resume.continuationOf).toBe(run.id);
  expect(resume.input).toContain('Continue');
  expect(resume.input).toContain('Which provider should I wire first?');

  const closed = await services.runs.run(profile.id, run.id);
  expect(closed.status).toBe('completed');
  expect(closed.question).toBeUndefined();

  // Idempotent: a second answer does not open another resume.
  const again = await services.runs.submit(
    profile.id,
    session.id,
    { text: 'Continue', requestKey: 'reply-again' },
    { ownerMessage: true },
  );
  expect(again.id).toBe(resume.id);
});

it('answers a waiting run through the explicit answer API', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.gatewaySession(profile.id);
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Need a decision',
    requestKey: 'ask-api',
  });

  let step = 0;
  await new AgentRuntime(services, () =>
    mockModel({
      doGenerate: async () => {
        step++;
        if (step === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'ask',
                toolName: 'ask_user',
                input: JSON.stringify({ prompt: 'Ship now?' }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }
        return answer('unused');
      },
    }),
  ).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).status).toBe('waiting');

  const resume = await services.runs.answerRun(profile.id, run.id, {
    text: 'Yes, ship it',
  });
  expect(resume.status).toBe('queued');
  expect(resume.requestKey).toBe(`ask-answer:${run.id}`);
  expect(resume.input).toContain('Yes, ship it');
});

it('isolates waiting runs between profiles', async () => {
  const services = await testServices();
  const a = await services.profiles.createProfile(input);
  const b = await services.profiles.createProfile({ ...input, name: 'Other' });
  const session = await services.sessions.createSession(a.id, { channel: 'api' });
  const run = await services.runs.submit(a.id, session.id, {
    text: 'Private ask',
    requestKey: 'iso',
  });

  await new AgentRuntime(services, () =>
    mockModel({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'ask',
            toolName: 'ask_user',
            input: JSON.stringify({ prompt: 'Secret choice?' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage,
        warnings: [],
      }),
    }),
  ).execute(a.id, run.id);

  await expect(services.runs.answerRun(b.id, run.id, { text: 'Nope' })).rejects.toMatchObject({
    statusCode: 404,
  });
  expect((await services.runs.run(a.id, run.id)).status).toBe('waiting');
});

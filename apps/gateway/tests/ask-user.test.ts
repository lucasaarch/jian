import { expect, it } from 'vitest';
import { buildRunQuestion, formatQuestionText } from '../src/agent/ask-user.js';
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
  let resumed = '';
  const model = mockModel({
    doGenerate: async (options) => {
      step++;
      if (step === 2) resumed = JSON.stringify(options.prompt);
      if (step === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'ask',
              toolName: 'ask_user',
              input: JSON.stringify({
                prompt: 'Which provider should I wire first?',
                choices: ['Gemini Live', 'OpenAI Realtime'],
                recommended: 'Gemini Live',
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
    choices: ['Gemini Live', 'OpenAI Realtime'],
    recommended: 'Gemini Live',
  });
  expect(parked.leaseOwner).toBeUndefined();
  expect(
    (await services.runs.activities(profile.id)).filter((item) => item.status === 'queued'),
  ).toEqual([]);
  expect((await services.sessions.session(profile.id, session.id)).objective?.status).toBe('open');

  const resume = await services.runs.submit(
    profile.id,
    session.id,
    { text: 'Gemini Live', requestKey: 'reply' },
    { ownerMessage: true },
  );

  expect(resume.status).toBe('queued');
  expect(resume.continuationOf).toBe(run.id);
  expect(resume.input).toContain('Gemini Live');
  expect(resume.input).toContain('Which provider should I wire first?');

  // The question stays with its answer, for the card that shows it answered.
  const closed = await services.runs.run(profile.id, run.id);
  expect(closed.status).toBe('completed');
  expect(closed.question).toMatchObject({
    prompt: 'Which provider should I wire first?',
    answer: 'Gemini Live',
    answeredBy: 'owner',
  });
  expect(closed.question?.answeredAt).toBeDefined();

  // The reply and the note to carry on are written for the agent, and say so.
  const written = await services.sessions.messages(profile.id, session.id);
  expect(written.find((message) => message.content === 'Gemini Live')?.purpose).toBe('answer');
  expect(written.find((message) => message.runId === resume.id)?.purpose).toBe('resume');

  // Idempotent: a second answer does not open another resume.
  const again = await services.runs.submit(
    profile.id,
    session.id,
    { text: 'Gemini Live', requestKey: 'reply-again' },
    { ownerMessage: true },
  );
  expect(again.id).toBe(resume.id);

  // The agent still reads both, exactly as before.
  await new AgentRuntime(services, () => model).execute(profile.id, resume.id);
  expect(resumed).toContain('Gemini Live');
  expect(resumed).toContain('The owner answered the mid-run question');
});

it('answers a waiting run through the explicit answer API', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createGatewaySession(profile.id, {});
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

it('keeps a recommendation only when it is one of the choices', () => {
  const asked = (recommended: string) =>
    buildRunQuestion(
      { prompt: 'Which?', choices: ['A', 'B'], recommended },
      new Date().toISOString(),
    );

  expect(asked('B').recommended).toBe('B');
  expect(asked('C').recommended).toBeUndefined();
  expect(formatQuestionText(asked('B'))).toContain('2. B (recommended)');
});

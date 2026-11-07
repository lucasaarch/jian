import { expect, it } from 'vitest';
import { buildRunQuestion, formatQuestionText } from '../src/agent/ask-user.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  // Room enough that no turn here reaches compaction, which these tests are not about.
  contextPolicy: { inputTokens: 64000 },
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
  const session = await services.sessions.createSession(profile.id, {
    channel: 'api',
    title: 'Questions',
  });
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
      doGenerate: async (options) => {
        // The conversation's title, asked for beside the turn.
        if (JSON.stringify(options.prompt).includes('You name a conversation')) {
          return answer('Shipping decision');
        }
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
  // A turn that stops to ask still names its conversation.
  expect((await services.sessions.session(profile.id, session.id)).title).toBe('Shipping decision');

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

it('keeps the question for the owner when a subagent report arrives while it waits', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, {
    channel: 'api',
    title: 'Questions',
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
      return step === 1
        ? {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'ask',
                toolName: 'ask_user',
                input: JSON.stringify({ prompt: 'Which provider should I wire first?' }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          }
        : answer('Wiring Gemini Live.');
    },
  });
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('waiting');

  // As a subagent's handoff arrives: the gateway's words, not the owner's.
  const report = 'Subagent "Pricing" finished.\nReport: Gemini Live costs less per minute.';
  const joined = await services.runs.submit(
    profile.id,
    session.id,
    { text: report, requestKey: 'task-worker-finished:pricing' },
    { purpose: 'resume', subagentReport: true },
  );
  expect(joined.id).toBe(run.id);
  const still = await services.runs.run(profile.id, run.id);
  expect(still.status).toBe('waiting');
  expect(still.question?.answer).toBeUndefined();
  expect(still.question?.answeredBy).toBeUndefined();

  const resume = await services.runs.submit(
    profile.id,
    session.id,
    { text: 'Gemini Live', requestKey: 'reply' },
    { ownerMessage: true },
  );
  expect((await services.runs.run(profile.id, run.id)).question).toMatchObject({
    answer: 'Gemini Live',
    answeredBy: 'owner',
  });
  // The report is in what the resumed turn reads, as data beside the answer.
  await new AgentRuntime(services, () => model).execute(profile.id, resume.id);
  expect(resumed).toContain('Gemini Live costs less per minute.');
});

it('refuses to continue another run while the agent waits on the owner, and keeps the question', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, {
    channel: 'api',
    title: 'Questions',
  });
  // A run that stopped, which the owner may continue with a reconciliation.
  const stopped = await services.runs.submit(profile.id, session.id, {
    text: 'Deploy the release.',
    requestKey: 'deploy',
  });
  await services.lifecycle.claim(stopped.id, profile.id, 'stopped');
  await services.lifecycle.finish(profile.id, stopped.id, 'stopped', 'interrupted', 'Lost.');
  const asking = await services.runs.submit(profile.id, session.id, {
    text: 'Which provider first?',
    requestKey: 'ask',
  });
  const model = mockModel({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'ask',
          toolName: 'ask_user',
          input: JSON.stringify({ prompt: 'Which provider should I wire first?' }),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
      usage,
      warnings: [],
    }),
  });
  await new AgentRuntime(services, () => model).execute(profile.id, asking.id);
  expect((await services.runs.run(profile.id, asking.id)).status).toBe('waiting');

  await expect(
    services.runs.continueRun(profile.id, stopped.id, {
      text: 'Carry on.',
      requestKey: 'continue',
      reconciliation: 'Nothing was deployed.',
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const still = await services.runs.run(profile.id, asking.id);
  expect(still.status).toBe('waiting');
  expect(still.question?.answer).toBeUndefined();
});

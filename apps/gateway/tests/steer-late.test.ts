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

it('answers a message sent while the model writes its final answer', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: { inputTokens: 64000 },
  });
  const session = await services.sessions.createSession(profile.id, {
    channel: 'api',
    title: 'Late',
  });
  const first = await services.runs.submit(profile.id, session.id, {
    text: 'Look at the users',
    requestKey: 'late-first',
  });

  const prompts: string[] = [];
  const model = mockModel({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      // The one step of the first turn: the person writes again while it answers, so no later
      // step is left to take the message.
      if (prompts.length === 1) {
        await services.runs.submit(profile.id, session.id, {
          text: 'I added MFA already',
          requestKey: 'late-second',
        });
        return answer('Users reviewed.');
      }
      return answer('Noted, MFA is in.');
    },
  });
  const runtime = new AgentRuntime(services, () => model);

  await runtime.execute(profile.id, first.id);
  expect((await services.runs.run(profile.id, first.id)).status).toBe('completed');

  const [next] = await services.runs.activities(profile.id);
  expect(next?.id).not.toBe(first.id);
  expect(next?.status).toBe('queued');

  // Sent, not yet read: the turn that will read it has not begun.
  const before = await services.sessions.messages(profile.id, session.id);
  expect(before.find((m) => m.content === 'I added MFA already')?.readAt).toBeUndefined();

  await runtime.execute(profile.id, next?.id ?? '');

  expect(prompts[1]).toContain('I added MFA already');
  expect((await services.runs.run(profile.id, next?.id ?? '')).output).toBe('Noted, MFA is in.');
  const after = await services.sessions.messages(profile.id, session.id);
  expect(after.find((m) => m.content === 'I added MFA already')?.readAt).toBeDefined();
});

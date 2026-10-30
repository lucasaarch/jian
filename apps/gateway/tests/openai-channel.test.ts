import { randomUUID } from 'node:crypto';
import type { ProviderModel, RunApproval } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ApiModels } from '../src/channels/api-models.js';
import { StreamedText } from '../src/channels/openai/answer.js';
import { Channels } from '../src/channels/service.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-admin-token-with-32-characters';
const admin = { authorization: `Bearer ${token}` };

const model = (id: string, reasoningEfforts: ProviderModel['reasoningEfforts']): ProviderModel => ({
  id,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  reasoningEfforts,
  inputModalities: ['text'],
  outputModalities: ['text'],
  known: true,
});

async function setup({ allowAll = true } = {}) {
  const services = await testServices();
  const channels = new Channels(services, async () => {
    throw new Error('Network forbidden in test');
  });
  const app = createApp({ ...services, channels, token, logger: false });
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });

  // Connected OpenAI first: the preference order, not the order of connection, decides.
  const openai = await services.providers.createProvider({
    name: 'OpenAI',
    kind: 'openai',
    secret: 'synthetic-openai-key',
  });
  const anthropic = await services.providers.createProvider({
    name: 'Anthropic',
    kind: 'anthropic',
    secret: 'synthetic-anthropic-key',
  });
  const lists: Record<string, ProviderModel[]> = {
    [openai.id]: [model('gpt-6-luna', ['low', 'medium', 'high']), model('shared-model', [])],
    [anthropic.id]: [model('claude-nova', ['low', 'high']), model('shared-model', [])],
  };
  channels.useModels(
    new ApiModels(services.providers, {
      list: async (providerId) => ({
        providerId,
        models: lists[providerId] ?? [],
        fetchedAt: new Date().toISOString(),
        stale: false,
      }),
    }),
  );

  const binding = (
    await app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/channels`,
      headers: admin,
      payload: { type: 'api' },
    })
  ).json() as { id: string; webhookToken: string };

  if (allowAll) {
    await app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${profile.id}/channels/${binding.id}`,
      headers: admin,
      payload: { allowAllContacts: true },
    });
  }

  const bearer = { authorization: `Bearer ${binding.webhookToken}` };
  const base = `/v1/channels/${binding.id}/openai`;

  const chat = (payload: Record<string, unknown>, headers: Record<string, string> = bearer) =>
    app.inject({ method: 'POST', url: `${base}/chat/completions`, headers, payload });

  /** The run the request just started, once it exists, claimed by a worker. */
  async function working() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      for (const run of await services.runs.activities(profile.id)) {
        if (await services.lifecycle.claim(run.id, profile.id, 'worker')) return run;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('No run was started');
  }

  /** Answers the request in flight with `text`, as a worker would. */
  async function answer(text: string) {
    const run = await working();
    await services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', text);
    return run;
  }

  /** One turn: the request, answered while it waits. */
  async function turn(payload: Record<string, unknown>, text = 'Done') {
    const [response, run] = await Promise.all([chat(payload), answer(text)]);
    return { response, run };
  }

  const sessionOf = async (sessionId: string) => services.sessions.session(profile.id, sessionId);

  return {
    services,
    channels,
    app,
    profile,
    binding,
    bearer,
    base,
    chat,
    working,
    answer,
    turn,
    sessionOf,
    providers: { openai, anthropic },
  };
}

const ask = (text: string, extra: Record<string, unknown> = {}) => ({
  model: 'default',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: text },
  ],
  ...extra,
});

describe('the OpenAI-compatible door of an API channel', () => {
  it('opens only to the channel token, and only for a live API channel', async () => {
    const f = await setup();

    try {
      const colleague = await f.services.profiles.createProfile({
        name: 'Nova',
        instructions: 'Help',
        model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      });
      const other = (
        await f.app.inject({
          method: 'POST',
          url: `/v1/profiles/${colleague.id}/channels`,
          headers: admin,
          payload: { type: 'api' },
        })
      ).json() as { webhookToken: string };

      const missing = await f.chat(ask('Hello'), {});
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toEqual({
        error: { message: 'Unauthorized', type: 'invalid_request_error', code: 'invalid_api_key' },
      });

      expect((await f.chat(ask('Hello'), { authorization: 'Bearer wrong' })).statusCode).toBe(401);
      // The host token opens the panel's API, not a channel's door.
      expect((await f.chat(ask('Hello'), admin)).statusCode).toBe(401);
      // Another channel's token is a wrong token here.
      const foreign = await f.app.inject({
        method: 'GET',
        url: `${f.base}/models`,
        headers: { authorization: `Bearer ${other.webhookToken}` },
      });
      expect(foreign.statusCode).toBe(401);

      // The channel's own header works as well as the bearer.
      const header = await f.app.inject({
        method: 'GET',
        url: `${f.base}/models`,
        headers: { 'x-jian-channel-token': f.binding.webhookToken },
      });
      expect(header.statusCode).toBe(200);

      const meta = (
        await f.app.inject({
          method: 'POST',
          url: `/v1/profiles/${f.profile.id}/channels`,
          headers: admin,
          payload: {
            type: 'whatsapp-business',
            whatsappBusiness: { verifyToken: 'synthetic-verify-token' },
          },
        })
      ).json() as { id: string; webhookToken: string };
      const notApi = await f.app.inject({
        method: 'GET',
        url: `/v1/channels/${meta.id}/openai/models`,
        headers: { authorization: `Bearer ${meta.webhookToken}` },
      });
      expect(notApi.statusCode).toBe(404);
      expect(notApi.json().error.code).toBe('not_found');

      await f.app.inject({
        method: 'PATCH',
        url: `/v1/profiles/${f.profile.id}/channels/${f.binding.id}`,
        headers: admin,
        payload: { enabled: false },
      });
      const paused = await f.chat(ask('Hello'));
      expect(paused.statusCode).toBe(403);
      expect(paused.json().error.type).toBe('permission_error');

      await f.app.inject({
        method: 'DELETE',
        url: `/v1/profiles/${f.profile.id}/channels/${f.binding.id}`,
        headers: admin,
      });
      expect((await f.chat(ask('Hello'))).statusCode).toBe(404);
      expect(await f.services.runs.activities(f.profile.id)).toEqual([]);
    } finally {
      await f.app.close();
    }
  });

  it('lists the models callers may name, each id once, with default first', async () => {
    const f = await setup();

    try {
      const response = await f.app.inject({
        method: 'GET',
        url: `${f.base}/models`,
        headers: f.bearer,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().object).toBe('list');
      expect(
        response
          .json()
          .data.map((item: { id: string; owned_by: string }) => [item.id, item.owned_by]),
      ).toEqual([
        ['default', 'jian'],
        ['claude-nova', 'anthropic'],
        ['shared-model', 'anthropic'],
        ['gpt-6-luna', 'openai'],
      ]);
    } finally {
      await f.app.close();
    }
  });

  it('answers with the run output in OpenAI shape, with its usage', async () => {
    const f = await setup();

    try {
      const pending = f.chat(ask('What is the capital of France?', { model: 'gpt-6-luna' }));
      const run = await f.working();
      await f.services.lifecycle.recordUsage(f.profile.id, run.id, 'worker', {
        inputTokens: 120,
        outputTokens: 30,
        steps: 1,
      });
      await f.services.lifecycle.finish(f.profile.id, run.id, 'worker', 'completed', 'Paris.');
      const response = await pending;

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: `chatcmpl-${run.id}`,
        object: 'chat.completion',
        created: expect.any(Number),
        model: 'gpt-6-luna',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Paris.' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      });
      // Only the new user message reached the agent.
      expect((await f.services.runs.run(f.profile.id, run.id)).input).toBe(
        'What is the capital of France?',
      );

      // A retry of the same turn is that turn: the same run, answered again, nothing new.
      const retry = await f.chat(ask('What is the capital of France?', { model: 'gpt-6-luna' }));
      expect(retry.json().id).toBe(`chatcmpl-${run.id}`);
      expect(retry.json().choices[0].message.content).toBe('Paris.');
    } finally {
      await f.app.close();
    }
  });

  it('streams the role, the text as it grows, the stop and [DONE]', async () => {
    const f = await setup();

    try {
      const pending = f.chat(ask('Say hello', { stream: true }));
      const run = await f.working();
      const at = () => new Date().toISOString();
      await f.services.lifecycle.progress(run.id, 'worker', {
        phase: 'writing',
        text: 'Hello',
        steps: 0,
        updatedAt: at(),
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await f.services.lifecycle.finish(f.profile.id, run.id, 'worker', 'completed', 'Hello world');
      const response = await pending;

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      const events = response.body
        .split('\n\n')
        .filter((block) => block.startsWith('data: '))
        .map((block) => block.slice(6));

      expect(events.at(-1)).toBe('[DONE]');
      const chunks = events.slice(0, -1).map((event) => JSON.parse(event));

      expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
      expect(chunks.every((chunk) => chunk.id === `chatcmpl-${run.id}`)).toBe(true);
      expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true);
      const contents = chunks
        .map((chunk) => chunk.choices[0].delta.content)
        .filter((content) => content !== undefined);
      expect(contents).toEqual(['Hello', ' world']);
      expect(chunks.at(-1).choices[0]).toEqual({ index: 0, delta: {}, finish_reason: 'stop' });
    } finally {
      await f.app.close();
    }
  });

  it('says a run is waiting for approval in Jian, and fails with the run error', async () => {
    const f = await setup();

    try {
      const pending = f.chat(ask('Send the report'));
      const run = await f.working();
      const approval: RunApproval = {
        id: randomUUID(),
        toolCallId: 'send-1',
        toolName: 'message_contact',
        kind: 'message',
        title: 'Send the report to the team',
        detail: 'One message to the team group.',
        confirmLabel: 'Send it',
        request: '{"to":"team"}',
        askedAt: new Date().toISOString(),
      };
      await f.services.lifecycle.waitForApproval(f.profile.id, run.id, 'worker', approval, {
        toolName: 'message_contact',
        toolCallId: 'send-1',
        kind: 'message',
        input: { to: 'team' },
        state: 'pending',
      });
      const waiting = await pending;

      expect(waiting.statusCode).toBe(200);
      expect(waiting.json().choices[0]).toMatchObject({
        message: {
          content: expect.stringContaining(
            'waiting for approval in Jian: Send the report to the team',
          ),
        },
        finish_reason: 'stop',
      });

      // Another conversation: the first one stays parked on its approval.
      const failing = f.chat(ask('Break'));
      const broken = await f.working();
      await f.services.lifecycle.finish(
        f.profile.id,
        broken.id,
        'worker',
        'failed',
        'The provider refused the request',
      );
      const failed = await failing;

      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({
        error: {
          message: 'The provider refused the request',
          type: 'server_error',
          code: 'server_error',
        },
      });
    } finally {
      await f.app.close();
    }
  });

  it('holds a sender the owner has not approved, and says so', async () => {
    const f = await setup({ allowAll: false });

    try {
      const held = await f.chat(ask('Hello'));

      expect(held.statusCode).toBe(403);
      expect(held.json().error.message).toContain('waiting for the owner to approve it in Jian');
      expect(await f.services.runs.activities(f.profile.id)).toEqual([]);
    } finally {
      await f.app.close();
    }
  });

  it('starts a conversation on Auto, refuses Full, and keeps Ask or Auto once asked', async () => {
    const f = await setup();

    try {
      const refused = await f.chat(ask('Delete the build folder', { protection: 'full' }));

      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toEqual({
        message: 'API channels allow protection up to auto.',
        type: 'permission_error',
        code: 'forbidden',
      });
      expect(await f.services.runs.activities(f.profile.id)).toEqual([]);

      const opening = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Tidy the build folder' },
      ];
      const first = await f.turn({ model: 'default', messages: opening });
      expect((await f.sessionOf(first.run.sessionId)).protection).toBe('auto');

      const history = [
        ...opening,
        { role: 'assistant', content: 'Done' },
        { role: 'user', content: 'Now the cache' },
      ];
      await f.turn({ model: 'default', protection: 'ask', messages: history });
      expect((await f.sessionOf(first.run.sessionId)).protection).toBe('ask');

      // A later message that says nothing about protection leaves it where it was asked.
      const later = [
        ...history,
        { role: 'assistant', content: 'Done' },
        { role: 'user', content: 'And the logs' },
      ];
      await f.turn({ model: 'default', messages: later });
      expect((await f.sessionOf(first.run.sessionId)).protection).toBe('ask');

      await f.turn({
        model: 'default',
        protection: 'auto',
        messages: [
          ...later,
          { role: 'assistant', content: 'Done' },
          { role: 'user', content: 'Go' },
        ],
      });
      expect((await f.sessionOf(first.run.sessionId)).protection).toBe('auto');
    } finally {
      await f.app.close();
    }
  });

  it('resolves a model by id, preferring the provider the gateway prefers', async () => {
    const f = await setup();

    try {
      const unknown = await f.chat(ask('Hello', { model: 'gpt-4o' }));
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error.message).toBe('Unknown model gpt-4o');

      const effort = await f.chat(ask('Hello', { model: 'gpt-6-luna', reasoning_effort: 'max' }));
      expect(effort.statusCode).toBe(400);
      expect(effort.json().error.message).toBe(
        'Model gpt-6-luna does not offer the reasoning effort max',
      );
      expect(await f.services.runs.activities(f.profile.id)).toEqual([]);

      const shared = await f.turn(ask('Hello', { model: 'shared-model' }));
      expect(shared.response.json().model).toBe('shared-model');
      expect((await f.sessionOf(shared.run.sessionId)).model).toEqual({
        providerId: f.providers.anthropic.id,
        modelId: 'shared-model',
      });
    } finally {
      await f.app.close();
    }
  });

  it('keeps the protection and model a conversation was given across its turns', async () => {
    const f = await setup();

    try {
      const history = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Plan the release' },
      ];
      const first = await f.turn(
        {
          model: 'gpt-6-luna',
          reasoning_effort: 'high',
          protection: 'ask',
          messages: history,
        },
        'Here is the plan.',
      );
      const second = await f.turn(
        {
          model: 'gpt-6-luna',
          reasoning_effort: 'high',
          messages: [
            ...history,
            { role: 'assistant', content: 'Here is the plan.' },
            { role: 'user', content: [{ type: 'text', text: 'Ship it' }] },
          ],
        },
        'Shipped.',
      );

      expect(second.run.sessionId).toBe(first.run.sessionId);
      expect((await f.services.runs.run(f.profile.id, second.run.id)).input).toBe('Ship it');
      const session = await f.sessionOf(first.run.sessionId);
      expect(session.protection).toBe('ask');
      expect(session.model).toEqual({
        providerId: f.providers.openai.id,
        modelId: 'gpt-6-luna',
        reasoningEffort: 'high',
      });

      // `default` goes back to the Model defaults; the protection stays as it was asked.
      await f.turn({
        model: 'default',
        messages: [
          ...history,
          { role: 'assistant', content: 'Here is the plan.' },
          { role: 'user', content: 'Ship it' },
          { role: 'assistant', content: 'Shipped.' },
          { role: 'user', content: 'Thanks' },
        ],
      });
      const after = await f.sessionOf(first.run.sessionId);
      expect(after.model).toBeUndefined();
      expect(after.protection).toBe('ask');
    } finally {
      await f.app.close();
    }
  });

  it('recognises a conversation by its chat id, or else by how it began', async () => {
    const f = await setup();

    try {
      const tagged = (text: string, count: number) => ({
        model: 'default',
        metadata: { chat_id: 'ticket-42' },
        messages: Array.from({ length: count }, (_, index) => ({
          role: index % 2 ? 'assistant' : 'user',
          content: index === count - 1 ? text : `Earlier ${index}`,
        })),
      });
      const a = await f.turn(tagged('First question', 1));
      const b = await f.turn(tagged('Unrelated opening', 3));
      expect(b.run.sessionId).toBe(a.run.sessionId);

      const opening = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Book a table' },
      ];
      const c = await f.turn({ model: 'default', messages: opening });
      const d = await f.turn({
        model: 'default',
        messages: [
          ...opening,
          { role: 'assistant', content: 'For how many?' },
          { role: 'user', content: 'Four people' },
        ],
      });
      const e = await f.turn({
        model: 'default',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Plan a trip' },
        ],
      });

      expect(d.run.sessionId).toBe(c.run.sessionId);
      expect(c.run.sessionId).not.toBe(a.run.sessionId);
      expect(e.run.sessionId).not.toBe(c.run.sessionId);
    } finally {
      await f.app.close();
    }
  });
});

describe('API channel conversations through the webhook', () => {
  it('start on Auto and the Model defaults, and take the same fields and refusals', async () => {
    const f = await setup();

    try {
      await f.services.providers.setModelDefaults({
        conversation: { providerId: f.providers.anthropic.id, modelId: 'claude-nova' },
      });
      const ingress = (payload: Record<string, unknown>) =>
        f.app.inject({
          method: 'POST',
          url: `/v1/ingress/${f.binding.id}`,
          headers: { 'x-jian-channel-token': f.binding.webhookToken },
          payload: { actorId: 'ada', chatId: 'ada', ...payload },
        });

      // None of the new fields: Auto, and the model the gateway's defaults name.
      const [accepted] = await Promise.all([
        ingress({ text: 'Hello', requestKey: 'one' }),
        f.answer('Hi'),
      ]);
      expect(accepted.statusCode).toBe(202);
      const run = await f.services.runs.run(f.profile.id, accepted.json().runId);
      const session = await f.sessionOf(run.sessionId);
      expect(session.protection).toBe('auto');
      expect(session.model).toBeUndefined();
      expect(run.modelSelection).toEqual({
        providerId: f.providers.anthropic.id,
        modelId: 'claude-nova',
      });

      expect(
        (await ingress({ text: 'Go', requestKey: 'two', protection: 'full' })).statusCode,
      ).toBe(403);
      expect((await ingress({ text: 'Go', requestKey: 'three', model: 'nope' })).statusCode).toBe(
        400,
      );
      const [changed] = await Promise.all([
        ingress({ text: 'Go', requestKey: 'four', protection: 'ask', model: 'gpt-6-luna' }),
        f.answer('Going'),
      ]);
      expect(changed.statusCode).toBe(202);
      const kept = await f.sessionOf(run.sessionId);
      expect(kept.protection).toBe('ask');
      expect(kept.model).toEqual({ providerId: f.providers.openai.id, modelId: 'gpt-6-luna' });

      // `default` with an effort: the Model defaults' model, at that effort.
      const [reset] = await Promise.all([
        ingress({ text: 'Think harder', requestKey: 'five', model: 'default', effort: 'high' }),
        f.answer('Thinking'),
      ]);
      expect(reset.statusCode).toBe(202);
      expect((await f.sessionOf(run.sessionId)).model).toEqual({
        providerId: f.providers.anthropic.id,
        modelId: 'claude-nova',
        reasoningEffort: 'high',
      });
    } finally {
      await f.app.close();
    }
  });
});

describe('a streamed answer', () => {
  it('sends only what is new, and a segment that started over after a blank line', () => {
    const text = new StreamedText();

    expect(text.next('Let me')).toBe('Let me');
    expect(text.next('Let me check')).toBe(' check');
    expect(text.next('Let me check')).toBe('');
    // A tool interrupted the answer; the next segment starts over.
    expect(text.next('')).toBe('');
    expect(text.next('Found')).toBe('\n\nFound');
    expect(text.next('Found it')).toBe(' it');
    // The final answer finishes the last segment, trimmed or not.
    expect(text.finish('Found it.')).toBe('.');
    expect(text.finish('Found it.')).toBe('');

    const trimmed = new StreamedText();
    expect(trimmed.next('Done\n')).toBe('Done\n');
    expect(trimmed.finish('Done')).toBe('');
  });
});

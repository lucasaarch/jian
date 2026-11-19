import { randomUUID } from 'node:crypto';
import { type ModelRole, supportsModelRole } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ModelCatalog } from '../src/providers/catalog-source.js';
import { ProviderModels } from '../src/providers/discovery.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const listing = (...ids: string[]) =>
  Response.json({ data: ids.map((id) => ({ id, display_name: id.toUpperCase() })) });

/** A catalog served from a fixture: the tests never reach models.dev. */
function testCatalog(entries: Record<string, unknown> = {}) {
  const body = { anthropic: { models: entries } };

  return new ModelCatalog(
    (async () => Response.json(body)) as typeof globalThis.fetch,
    () => 0,
    'https://models.test/api.json',
  );
}

async function setup(respond: () => Promise<Response>, catalog?: ModelCatalog) {
  let now = 1_700_000_000_000;
  const services = await testServices(() => now, catalog);
  const profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });
  const provider = await services.providers.createProvider({
    name: 'Anthropic',
    kind: 'anthropic',
    secret: 'synthetic-anthropic-key',
  });
  const models = new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    respond,
    {
      ttlMs: 60_000,
      clock: () => now,
      ...(catalog ? { catalog } : {}),
    },
  );

  return {
    services,
    profile,
    provider,
    models,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it('keeps the saved default and the last list when the provider is unreachable', async () => {
  let reachable = true;
  const { services, provider, models, advance } = await setup(async () => {
    if (!reachable) throw new Error('connect ECONNREFUSED');

    return listing('claude-sonnet-4-5', 'claude-opus-4-5');
  });

  await services.providers.setModelDefaults({
    conversation: { providerId: provider.id, modelId: 'claude-sonnet-4-5', reasoningEffort: 'low' },
  });

  const fresh = await models.list(provider.id);

  expect(fresh.stale).toBe(false);
  expect(fresh.models.map((model) => model.id)).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5']);

  reachable = false;
  advance(120_000);

  const offline = await models.list(provider.id);

  expect(offline.stale).toBe(true);
  expect(offline.reason).toBeDefined();
  expect(offline.models.map((model) => model.id)).toEqual(fresh.models.map((model) => model.id));
  expect(offline.fetchedAt).toBe(fresh.fetchedAt);

  // The outage must not reach into stored configuration.
  expect((await services.providers.modelDefaults()).conversation).toEqual({
    providerId: provider.id,
    modelId: 'claude-sonnet-4-5',
    reasoningEffort: 'low',
  });
  expect(
    (await services.providers.providers()).find((item) => item.id === provider.id)?.revokedAt,
  ).toBeUndefined();
});

it('reports an unreachable provider as empty instead of inventing a list', async () => {
  const { provider, models } = await setup(async () => {
    throw new Error('connect ECONNREFUSED');
  });

  const list = await models.list(provider.id);

  expect(list).toMatchObject({ providerId: provider.id, models: [], stale: true });
  expect(list.reason).toBeDefined();
});

it('answers inside the cache window without reaching the provider again', async () => {
  let reachable = true;
  const { provider, models, advance } = await setup(async () => {
    if (!reachable) throw new Error('connect ECONNREFUSED');

    return listing('claude-sonnet-4-5');
  });

  await models.list(provider.id);
  reachable = false;
  advance(30_000);

  expect(await models.list(provider.id)).toMatchObject({ stale: false });
});

it('takes what the public catalog knows and marks the model it does not cover', async () => {
  const { services, provider, models } = await setup(
    async () => listing('claude-sonnet-4-5', 'claude-next-experimental'),
    testCatalog({
      'claude-sonnet-4-5': {
        name: 'Claude Sonnet 4.5',
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ['text', 'image', 'pdf'] },
        reasoning_options: [
          { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        ],
      },
    }),
  );

  const list = await models.list(provider.id);
  const known = list.models.find((model) => model.id === 'claude-sonnet-4-5');
  const unknown = list.models.find((model) => model.id === 'claude-next-experimental');

  // Nothing about this model is written in this repository: it comes from the catalog.
  expect(known).toMatchObject({ known: true, contextWindow: 200_000, maxOutputTokens: 64_000 });
  expect(known?.reasoningEfforts).toContain('high');
  expect(known?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(unknown).toMatchObject({
    known: false,
    contextWindow: 128_000,
    reasoningEfforts: [],
    inputModalities: ['text'],
  });

  // Unknown capabilities never make a model unselectable.
  const saved = await services.providers.setModelDefaults({
    conversation: { providerId: provider.id, modelId: 'claude-next-experimental' },
  });

  expect(saved.conversation?.modelId).toBe('claude-next-experimental');

  // Nor does an uncatalogued model refuse an effort: the provider is the one who knows.
  const withEffort = await services.providers.setModelDefaults({
    conversation: {
      providerId: provider.id,
      modelId: 'claude-next-experimental',
      reasoningEffort: 'high',
    },
  });

  expect(withEffort.conversation?.reasoningEffort).toBe('high');

  // A level the catalog does contradict is still refused.
  await expect(
    services.providers.setModelDefaults({
      conversation: {
        providerId: provider.id,
        modelId: 'claude-sonnet-4-5',
        reasoningEffort: 'minimal',
      },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('keeps model discovery admin-only and never echoes the key behind it', async () => {
  const { services, provider, models } = await setup(async () => listing('claude-sonnet-4-5'));
  const app = createApp({ ...services, providerModels: models, token, logger: false });
  apps.push(app);

  const path = `/v1/providers/${provider.id}/models`;

  expect((await app.inject({ url: path })).statusCode).toBe(401);

  const allowed = await app.inject({ url: path, headers });

  expect(allowed.statusCode).toBe(200);
  expect(allowed.body).not.toContain('synthetic-anthropic-key');

  // A provider that is not configured is not found, whoever asks.
  const missing = await app.inject({ url: `/v1/providers/${randomUUID()}/models`, headers });

  expect(missing.statusCode).toBe(404);
});

it('lists xAI models with a Bearer key against the OpenAI-shaped endpoint', async () => {
  const services = await testServices();
  const provider = await services.providers.createProvider({
    name: 'xAI',
    kind: 'xai',
    secret: 'xai_synthetic',
  });

  const called: string[] = [];
  const models = new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    (async (input, init) => {
      called.push(String(input));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xai_synthetic');
      return listing('grok-4', 'grok-3-mini');
    }) as typeof globalThis.fetch,
  );

  const list = await models.list(provider.id);

  expect(called[0]).toBe('https://api.x.ai/v1/models');
  // Text to speech takes no model at xAI; the listing names it so it can be chosen.
  expect(list.models.map((model) => model.id)).toEqual(['grok-3-mini', 'grok-4', 'grok-tts']);
  expect(list.stale).toBe(false);
});

it('offers a Gemini model once when Google lists it under its preview id as well', async () => {
  const services = await testServices();
  const provider = await services.providers.createProvider({
    name: 'Gemini',
    kind: 'google',
    secret: 'synthetic-gemini-key',
  });
  const models = new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    (async () =>
      Response.json({
        models: [
          { name: 'models/gemini-3-pro-image-preview', displayName: 'Nano Banana Pro' },
          { name: 'models/gemini-3-pro-image', displayName: 'Nano Banana Pro' },
          { name: 'models/nano-banana-pro-preview', displayName: 'Nano Banana Pro' },
          { name: 'models/gemini-2.5-flash-image', displayName: 'Nano Banana' },
          { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS' },
        ],
      })) as unknown as typeof globalThis.fetch,
  );

  const list = await models.list(provider.id);

  // The stable id stays; a preview with no stable twin is still offered.
  expect(list.models.map((model) => model.id)).toEqual([
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-preview-tts',
    'gemini-3-pro-image',
  ]);
});

it('takes the router listing as the whole truth about a model', async () => {
  const services = await testServices();
  const _profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });

  const provider = await services.providers.createProvider({
    name: 'OpenRouter',
    kind: 'openrouter',
    secret: 'synthetic-key',
  });

  const fetcher = (async () =>
    Response.json({
      data: [
        {
          id: 'anthropic/claude-sonnet-5',
          name: 'Claude Sonnet 5',
          context_length: 1_000_000,
          top_provider: { max_completion_tokens: 128_000 },
          architecture: { input_modalities: ['text', 'image', 'file'] },
          supported_parameters: ['reasoning_effort', 'tools'],
        },
        {
          id: 'some/plain-model',
          context_length: 32_768,
          top_provider: { max_completion_tokens: null },
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['tools'],
        },
      ],
    })) as typeof globalThis.fetch;

  const list = await new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    fetcher,
  ).list(provider.id);
  const sonnet = list.models.find((model) => model.id === 'anthropic/claude-sonnet-5');
  const plain = list.models.find((model) => model.id === 'some/plain-model');

  // Reported, not guessed: no row for either model exists in the capability table.
  expect(sonnet).toMatchObject({
    known: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    displayName: 'Claude Sonnet 5',
  });
  expect(sonnet?.inputModalities).toEqual(['text', 'image', 'pdf']);
  expect(sonnet?.reasoningEfforts).toContain('high');

  expect(plain).toMatchObject({ known: true, contextWindow: 32_768 });
  expect(plain?.reasoningEfforts).toEqual([]);
});

it('offers OpenRouter models that draw, speak or transcribe, and marks one without tools', async () => {
  const services = await testServices();
  const provider = await services.providers.createProvider({
    name: 'OpenRouter',
    kind: 'openrouter',
    secret: 'synthetic-key',
  });
  const chat = ['/api/v1/chat/completions', '/api/v1/responses'];
  const called: string[] = [];
  const fetcher = (async (input: unknown) => {
    called.push(String(input));
    return Response.json({
      data: [
        {
          id: 'some/chat',
          context_length: 32_768,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: ['tools'],
          endpoints: chat,
        },
        {
          id: 'venice/uncensored',
          context_length: 32_768,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          supported_parameters: ['temperature'],
          endpoints: chat,
        },
        {
          id: 'openai/gpt-image-1',
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
          supported_parameters: [],
          endpoints: ['/api/v1/images'],
        },
        {
          id: 'elevenlabs/eleven-v3',
          architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
          supported_parameters: [],
          supported_voices: ['george', 'sarah'],
          endpoints: ['/api/v1/audio/speech'],
        },
        {
          id: 'openai/whisper-1',
          architecture: { input_modalities: ['audio'], output_modalities: ['transcription'] },
          supported_parameters: [],
          endpoints: ['/api/v1/audio/transcriptions'],
        },
        {
          id: 'auto/router',
          architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] },
          supported_parameters: ['tools'],
          endpoints: chat,
        },
        {
          id: 'some/embedding',
          architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
          endpoints: ['/api/v1/embeddings'],
        },
      ],
    });
  }) as typeof globalThis.fetch;

  const list = await new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    fetcher,
  ).list(provider.id);
  const offered = (role: ModelRole) =>
    list.models
      .filter((model) => supportsModelRole(provider, model, role))
      .map((model) => model.id);

  // Without the parameter the router lists only the models that answer in text.
  expect(called[0]).toContain('output_modalities=all');
  expect(list.models.map((model) => model.id)).not.toContain('some/embedding');
  expect(offered('image')).toEqual(['openai/gpt-image-1']);
  expect(offered('speech')).toEqual(['elevenlabs/eleven-v3']);
  expect(offered('audio')).toEqual(['openai/whisper-1']);
  expect(offered('conversation')).toEqual(['auto/router', 'some/chat', 'venice/uncensored']);
  expect(list.models.find((model) => model.id === 'elevenlabs/eleven-v3')?.voices).toEqual([
    'george',
    'sarah',
  ]);
  // A request carrying tools is refused by this one, so a run sends it none.
  expect(list.models.find((model) => model.id === 'venice/uncensored')?.tools).toBe(false);
  expect(list.models.find((model) => model.id === 'some/chat')?.tools).toBeUndefined();
});

it('lets the owner change one model default while a stored role is no longer offered', async () => {
  const catalog = testCatalog({
    'claude-sonnet-4-5': {
      limit: { context: 200_000, output: 64_000 },
      modalities: { input: ['text'], output: ['text'] },
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
    },
  });
  const { services, provider } = await setup(async () => listing('claude-sonnet-4-5'), catalog);
  const { writeModelDefaults } = await import('../src/providers/repository.js');
  const selection = { providerId: provider.id, modelId: 'claude-sonnet-4-5' as const };

  // Plant a vision choice that today's catalog rejects for image analysis.
  await writeModelDefaults(
    services.store.db,
    {
      conversation: selection,
      channel: selection,
      compaction: null,
      image: 'disabled',
      vision: selection,
      audio: 'disabled',
      speech: 'disabled',
      transcription: null,
    },
    new Date(),
  );

  const saved = await services.providers.setModelDefaults({
    conversation: { ...selection, reasoningEffort: 'high' },
    channel: selection,
    compaction: null,
    image: 'disabled',
    vision: selection,
    audio: 'disabled',
    speech: 'disabled',
  });
  expect(saved.conversation?.reasoningEffort).toBe('high');
  expect(saved.vision).toEqual(selection);

  // A change to the stale role still has to pass today's checks.
  await expect(
    services.providers.setModelDefaults({
      conversation: { ...selection, reasoningEffort: 'high' },
      channel: selection,
      compaction: null,
      image: 'disabled',
      vision: { ...selection, reasoningEffort: 'low' },
      audio: 'disabled',
      speech: 'disabled',
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining('This model cannot run vision'),
  });
});

it('reads a catalog that carries a malformed entry among the good ones', async () => {
  const services = await testServices();
  const _profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });

  const provider = await services.providers.createProvider({
    name: 'Anthropic',
    kind: 'anthropic',
    secret: 'synthetic-key',
  });

  // One provider with a null where a string belongs must not cost every other model its
  // capabilities: nobody here reviews this source before it is used.
  const catalog = new ModelCatalog(
    (async () =>
      Response.json({
        broken: {
          models: { 'bad-model': { reasoning_options: [{ type: 'effort', values: [null] }] } },
        },
        anthropic: {
          models: {
            'claude-sonnet-5': {
              limit: { context: 1_000_000, output: 128_000 },
              modalities: { input: ['text', 'image', 'pdf'] },
              reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            },
          },
        },
      })) as typeof globalThis.fetch,
    () => 0,
    'https://models.test/api.json',
  );

  const models = new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    async () => listing('claude-sonnet-5'),
    { catalog },
  );
  const list = await models.list(provider.id);

  expect(list.models[0]).toMatchObject({ known: true, contextWindow: 1_000_000 });
});

import { describe, expect, it } from 'vitest';
import { ModelCatalog } from '../src/providers/catalog-source.js';
import { ProviderModels } from '../src/providers/discovery.js';
import { ModelFallback } from '../src/providers/fallback.js';
import { testServices } from './helpers/services.js';

const chat = (releaseDate: string, context = 200_000) => ({
  modalities: { input: ['text'], output: ['text'] },
  limit: { context, output: 8192 },
  release_date: releaseDate,
});

/** What a vendor listing really looks like: chat models mixed with everything else. */
const catalogued = {
  'claude-3-haiku': chat('2024-03-07', 200_000),
  'claude-sonnet-4-5': chat('2025-09-29', 200_000),
  'voice-preview': {
    modalities: { input: ['text'], output: ['audio'] },
    release_date: '2026-01-01',
  },
  'embed-v1': { modalities: { input: ['text'], output: [] }, release_date: '2026-02-01' },
};

async function setup(ids: string[], entries: Record<string, unknown> = catalogued) {
  const now = 1_700_000_000_000;
  const catalog = new ModelCatalog(
    (async () => Response.json({ anthropic: { models: entries } })) as typeof globalThis.fetch,
    () => now,
    'https://models.test/api.json',
  );

  const services = await testServices(() => now, catalog);
  const profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });
  const provider = await services.providers.createProvider({
    name: 'Anthropic',
    kind: 'anthropic',
    secret: 'synthetic-anthropic-key',
  });

  const models = new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    (async () =>
      Response.json({ data: ids.map((id) => ({ id })) })) as unknown as typeof globalThis.fetch,
    { ttlMs: 60_000, clock: () => now, catalog },
  );

  const fallback = new ModelFallback(services.providers, models, catalog);

  services.runs.useFallback(fallback);

  return { services, profile, provider, fallback };
}

describe('a profile with a provider but no model chosen', () => {
  it('takes the newest model that both reads and writes text', async () => {
    const { provider, fallback } = await setup([
      'embed-v1',
      'claude-3-haiku',
      'voice-preview',
      'claude-sonnet-4-5',
    ]);

    expect(await fallback.pick()).toEqual({
      providerId: provider.id,
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('answers without the owner configuring anything, and keeps the choice', async () => {
    const { services, profile } = await setup(['claude-3-haiku', 'claude-sonnet-4-5']);
    const session = await services.sessions.createSession(profile.id, { title: 'First' });

    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Oi',
      requestKey: 'first',
    });

    expect(run.model?.modelId).toBe('claude-sonnet-4-5');

    // Written as the default, so the panel agrees and the next run does not choose again.
    const defaults = await services.providers.modelDefaults(profile.id);

    expect(defaults.conversation?.modelId).toBe('claude-sonnet-4-5');
  });

  it('picks again when the chosen model belongs to a provider that was removed', async () => {
    const { services, profile } = await setup(['claude-3-haiku', 'claude-sonnet-4-5']);
    const gone = await services.providers.createProvider({
      name: 'Old key',
      kind: 'openai',
      secret: 'synthetic-old-key',
    });

    await services.providers.setModelDefaults(profile.id, {
      conversation: { providerId: gone.id, modelId: 'gpt-4.1' },
    });
    await services.providers.revokeProvider(gone.id);

    const session = await services.sessions.createSession(profile.id, { title: 'Stale' });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Hello',
      requestKey: 'stale',
    });

    expect(run.model?.modelId).toBe('claude-sonnet-4-5');
    expect((await services.providers.modelDefaults(profile.id)).conversation?.modelId).toBe(
      'claude-sonnet-4-5',
    );
  });

  it('never picks a model the catalog cannot vouch for', async () => {
    const { fallback } = await setup(['mystery-model', 'embed-v1'], {
      'embed-v1': { modalities: { input: ['text'], output: [] } },
    });

    expect(await fallback.pick()).toBeNull();
  });

  it('leaves a model the owner chose alone', async () => {
    const { services, profile, provider } = await setup(['claude-3-haiku', 'claude-sonnet-4-5']);

    await services.providers.setModelDefaults(profile.id, {
      conversation: { providerId: provider.id, modelId: 'claude-3-haiku' },
    });

    const session = await services.sessions.createSession(profile.id, { title: 'Chosen' });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Oi',
      requestKey: 'chosen',
    });

    expect(run.model?.modelId).toBe('claude-3-haiku');
  });
});

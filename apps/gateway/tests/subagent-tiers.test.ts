import type { ProviderModelList, ProviderRecord } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import type { Judge } from '../src/decisions/service.js';
import { ModelCatalog } from '../src/providers/catalog-source.js';
import { modelTier, TierModels } from '../src/providers/tiers.js';
import { chooseTier } from '../src/tasks/tier.js';
import { testServices } from './helpers/services.js';

const now = 1_700_000_000_000;
const chat = (release: string, effort = false) => ({
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 200_000, output: 32_000 },
  release_date: release,
  ...(effort ? { reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] } : {}),
});

/** One public catalog for every vendor the tests list models from. */
const catalog = new ModelCatalog(
  (async () =>
    Response.json({
      anthropic: {
        models: {
          'claude-opus-5-5': chat('2026-08-01', true),
          'claude-sonnet-5-5': chat('2026-08-01', true),
          'claude-haiku-5-5': chat('2026-08-01'),
        },
      },
      openai: {
        models: {
          'gpt-6-astra': chat('2026-07-01', true),
          'gpt-6': chat('2026-07-01', true),
          'gpt-6-mini': chat('2026-07-01', true),
          'text-embedding-4': {
            modalities: { input: ['text'], output: [] },
            release_date: '2026-07-01',
          },
        },
      },
      xai: {
        models: {
          'grok-5': chat('2026-06-01'),
          'grok-5-fast': chat('2026-06-01'),
          'grok-5-heavy': chat('2026-06-01'),
        },
      },
    })) as typeof globalThis.fetch,
  () => now,
  'https://models.test/api.json',
);

const provider = (
  id: string,
  kind: ProviderRecord['kind'],
  extra: Partial<ProviderRecord> = {},
): ProviderRecord => ({
  id,
  name: id,
  kind,
  createdAt: new Date(now).toISOString(),
  ...extra,
});

const listed: Record<string, string[]> = {
  'openai-key': ['gpt-6-astra', 'gpt-6', 'gpt-6-mini', 'text-embedding-4'],
  chatgpt: ['gpt-6-astra', 'gpt-6', 'gpt-6-mini'],
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  'anthropic-key': ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  grok: ['grok-5', 'grok-5-fast', 'grok-5-heavy'],
};

function tiers(records: ProviderRecord[]) {
  return new TierModels(
    { providers: async () => records },
    {
      list: async (providerId: string): Promise<ProviderModelList> => ({
        providerId,
        models: (listed[providerId] ?? []).map((id) => ({
          id,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          reasoningEfforts: [],
          inputModalities: ['text'],
          outputModalities: ['text'],
          known: true,
        })),
        fetchedAt: new Date(now).toISOString(),
        stale: false,
      }),
    },
    catalog,
  );
}

describe('the tier a model is in', () => {
  it('reads it from the family name', () => {
    const tier = (id: string) => modelTier({ id });

    expect(
      ['claude-haiku-5-5', 'gpt-6-mini', 'gpt-5-nano', 'grok-5-fast', 'gemini-3-flash'].map(tier),
    ).toEqual(['light', 'light', 'light', 'light', 'light']);
    expect(
      ['claude-opus-5-5', 'gpt-6-astra', 'gemini-3-pro', 'grok-5-heavy', 'gpt-5.1-codex-max'].map(
        tier,
      ),
    ).toEqual(['deep', 'deep', 'deep', 'deep', 'deep']);
    expect(['claude-sonnet-5-5', 'gpt-6', 'grok-5', 'o3'].map(tier)).toEqual([
      'standard',
      'standard',
      'standard',
      'standard',
    ]);
  });
});

describe('the model a tier gets', () => {
  const apiKeys = [
    provider('openai-key', 'openai', { authMode: 'api' }),
    provider('anthropic-key', 'anthropic', { credential: 'key' }),
  ];

  it('goes to a subscription before any API key', async () => {
    const picker = tiers([
      ...apiKeys,
      provider('claude', 'anthropic', { credential: 'subscription' }),
      provider('chatgpt', 'openai', { authMode: 'codex' }),
    ]);

    expect(await picker.pick('deep')).toMatchObject({
      providerId: 'claude',
      modelId: 'claude-opus-5-5',
      reasoningEffort: 'high',
    });
    expect(await picker.pick('light')).toMatchObject({
      providerId: 'claude',
      modelId: 'claude-haiku-5-5',
    });
    // The parent's subscription is asked first among the subscriptions.
    expect(await picker.pick('standard', 'chatgpt')).toEqual({
      providerId: 'chatgpt',
      modelId: 'gpt-6',
      reasoningEffort: 'medium',
    });
  });

  it('takes Grok before other API keys, and the parent provider first among keys', async () => {
    const picker = tiers([...apiKeys, provider('grok', 'xai')]);

    expect(await picker.pick('light')).toMatchObject({
      providerId: 'grok',
      modelId: 'grok-5-fast',
    });
    // Grok has no effort levels in this catalog, so none is set.
    expect(await picker.pick('deep')).toEqual({ providerId: 'grok', modelId: 'grok-5-heavy' });

    const keys = tiers(apiKeys);
    expect(await keys.pick('light', 'anthropic-key')).toMatchObject({
      providerId: 'anthropic-key',
      modelId: 'claude-haiku-5-5',
    });
    expect(await keys.pick('light')).toMatchObject({
      providerId: 'openai-key',
      modelId: 'gpt-6-mini',
    });
  });

  it('skips a revoked credential and answers nothing when no provider has the tier', async () => {
    const picker = tiers([
      provider('claude', 'anthropic', {
        credential: 'subscription',
        revokedAt: new Date(now).toISOString(),
      }),
    ]);

    expect(await picker.pick('standard')).toBeNull();
  });
});

describe('the tier a subagent gets', () => {
  const work = { name: 'Changelog', role: 'execute', brief: 'Add one line to the changelog.' };
  const answering =
    (choice: string, probability: number): Judge =>
    async () => ({
      tier: {
        type: 'choice',
        choice,
        probabilities: { [choice]: probability },
        confidence: probability,
      },
    });

  it('is the agent’s own pick when it made one, without asking Jev', async () => {
    let asked = false;
    const judge: Judge = async () => {
      asked = true;
      return undefined;
    };

    expect(await chooseTier(judge, { ...work, tier: 'deep' })).toEqual({
      tier: 'deep',
      tierBy: 'agent',
    });
    expect(asked).toBe(false);
  });

  it('is Jev’s pick when Jev is sure enough, and standard otherwise', async () => {
    expect(await chooseTier(answering('light', 0.8), work)).toEqual({
      tier: 'light',
      tierBy: 'jev',
    });
    expect(await chooseTier(answering('light', 0.3), work)).toEqual({
      tier: 'standard',
      tierBy: 'default',
    });
    expect(await chooseTier(async () => undefined, { ...work, tier: 'auto' })).toEqual({
      tier: 'standard',
      tierBy: 'default',
    });
    expect(await chooseTier(undefined, work)).toEqual({ tier: 'standard', tierBy: 'default' });
  });
});

describe('spawning a subagent', () => {
  async function setup() {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Coordinator',
      instructions: 'Help the owner.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const claude = await services.providers.createProvider({
      name: 'Anthropic',
      kind: 'anthropic',
      secret: 'synthetic-anthropic-subscription-token',
      credential: 'subscription',
    });
    const session = await services.sessions.createSession(profile.id, { channel: 'api' });
    const parent = await services.runs.submit(profile.id, session.id, {
      text: 'Ship the release.',
      requestKey: 'parent',
    });
    const asked: string[] = [];
    services.work.useTiers({
      pick: async (tier) => {
        asked.push(tier);
        return { providerId: claude.id, modelId: `claude-${tier}` };
      },
    });

    return { services, profile, session, parent, claude, asked };
  }

  const assignment = {
    role: 'execute' as const,
    name: 'Release notes',
    identity: 'Write release notes.',
    brief: 'Draft the release notes from the merged pull requests.',
  };

  it('freezes the tier’s model on the run and lists what the panel needs', async () => {
    const { services, profile, session, parent, claude, asked } = await setup();

    const child = await services.work.spawnInConversation(
      parent,
      { ...assignment, tier: 'light' },
      'one',
    );
    // Jev has no key here, so a tier left open falls back to standard.
    await services.work.spawnInConversation(parent, { ...assignment, name: 'Checks' }, 'two');

    expect(child).toMatchObject({ tier: 'light', model: 'claude-light' });
    expect(asked).toEqual(['light', 'standard']);
    expect(await services.work.conversationSubagents(profile.id, session.id)).toMatchObject([
      {
        runId: child.runId,
        tier: 'light',
        tierBy: 'agent',
        modelSelection: { providerId: claude.id, modelId: 'claude-light' },
      },
      { name: 'Checks', tier: 'standard', tierBy: 'default' },
    ]);
  });

  it('returns the run it started when the same spawn is retried, without picking again', async () => {
    const { services, parent, asked } = await setup();

    const first = await services.work.spawnInConversation(parent, assignment, 'same');
    const again = await services.work.spawnInConversation(parent, assignment, 'same');

    expect(again.runId).toBe(first.runId);
    expect(asked).toEqual(['standard']);
    await expect(
      services.work.spawnInConversation(parent, { ...assignment, brief: 'Other work.' }, 'same'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('runs on the parent’s model when the tier’s model cannot be used', async () => {
    const { services, profile, parent } = await setup();
    services.work.useTiers({
      pick: async () => ({ providerId: '00000000-0000-4000-8000-000000000000', modelId: 'gone' }),
    });

    const child = await services.work.spawnInConversation(parent, assignment, 'fallback');
    const run = await services.runs.run(profile.id, child.runId);

    expect(run.status).toBe('queued');
    expect(run.modelSelection).toEqual(parent.modelSelection);
  });
});

import type { ModelConfig } from '@jian/contracts';
import { generateText } from 'ai';
import { afterEach, expect, it } from 'vitest';
import {
  claudeLimits,
  forgetClaudeLimits,
  recordClaudeLimits,
} from '../src/providers/claude-limits.js';
import { resolveModel } from '../src/providers/models.js';
import { SubscriptionUsageReader } from '../src/providers/subscription-usage.js';
import { testServices } from './helpers/services.js';

// What runs said of the windows is kept per process; each test starts from none.
afterEach(() => forgetClaudeLimits());

it('reads Codex weekly and Claude subscription windows without exposing credentials', async () => {
  const services = await testServices();
  const token = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' },
    }),
  ).toString('base64url')}.x`;
  await services.providers.configureCodexProvider('{"access_token":"synthetic"}');
  await services.providers.createProvider({
    name: 'Claude',
    kind: 'anthropic',
    credential: 'subscription',
    secret: 'sk-ant-oat-synthetic-test-only',
  });
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    seen.push(url);
    expect(authorization).toMatch(/^Bearer /);
    return Response.json(
      url.includes('wham')
        ? {
            rate_limit: {
              primary_window: { used_percent: 32, reset_at: 1_800_000_000 },
              secondary_window: { used_percent: 61 },
            },
          }
        : {
            five_hour: { utilization: 18, resets_at: '2027-01-15T12:00:00Z' },
            seven_day: { utilization: 47 },
          },
    );
  }) as typeof fetch;
  const reader = new SubscriptionUsageReader(
    services.providers,
    services.gatewayVault,
    fetcher,
    () => Date.parse('2027-01-15T10:00:00Z'),
  );
  reader.useCodexLogin({ accessToken: async () => token });

  const result = await reader.read();
  expect(result).toMatchObject([
    {
      provider: 'codex',
      status: 'available',
      fiveHour: null,
      weekly: { usedPercent: 32 },
    },
    {
      provider: 'claude',
      status: 'available',
      fiveHour: { usedPercent: 18 },
      weekly: { usedPercent: 47 },
    },
  ]);
  expect(result[0]?.weekly?.resetsAt).toBe('2027-01-15T08:00:00.000Z');
  expect(JSON.stringify(result)).not.toContain('synthetic');
  await reader.read();
  expect(seen).toHaveLength(2);
});

it('reports an unavailable window instead of inventing zero after endpoint failure', async () => {
  const services = await testServices();
  await services.providers.createProvider({
    name: 'Claude',
    kind: 'anthropic',
    credential: 'subscription',
    secret: 'sk-ant-oat-synthetic-test-only',
  });
  const reader = new SubscriptionUsageReader(
    services.providers,
    services.gatewayVault,
    (async () => new Response('secret echoed here', { status: 401 })) as typeof fetch,
  );

  expect(await reader.read()).toEqual([
    { provider: 'claude', status: 'unavailable', fiveHour: null, weekly: null },
  ]);
});

it('shows Claude windows from the last run when the usage endpoint refuses a setup token', async () => {
  const services = await testServices();
  const provider = await services.providers.createProvider({
    name: 'Claude',
    kind: 'anthropic',
    credential: 'subscription',
    secret: 'sk-ant-oat-synthetic-test-only',
  });
  const now = Date.parse('2027-01-15T10:00:00Z');
  const inSeconds = (hours: number) => String(Math.floor(now / 1000) + hours * 3600);
  // A run on the subscription: Anthropic's answer carries the windows in its headers.
  const answer = (async () =>
    Response.json(
      {
        id: 'msg_synthetic',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 },
      },
      {
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.18',
          'anthropic-ratelimit-unified-5h-reset': inSeconds(2),
          'anthropic-ratelimit-unified-7d-utilization': '0.47',
          'anthropic-ratelimit-unified-7d-reset': inSeconds(72),
        },
      },
    )) as typeof fetch;
  const model = await resolveModel(
    {
      provider: 'anthropic',
      providerId: provider.id,
      modelId: 'claude-opus-5-5',
      credential: 'subscription',
    } as ModelConfig,
    {},
    answer,
    'sk-ant-oat-synthetic-test-only',
  );
  await generateText({ model, prompt: 'Hello.' });

  const reader = new SubscriptionUsageReader(
    services.providers,
    services.gatewayVault,
    (async () => new Response('{}', { status: 429 })) as typeof fetch,
    () => now,
  );

  const [claude] = await reader.read();
  expect(claude).toMatchObject({
    provider: 'claude',
    status: 'available',
    fiveHour: { usedPercent: 18, resetsAt: new Date((now / 1000 + 7200) * 1000).toISOString() },
    weekly: { usedPercent: 47 },
  });
});

it('leaves out a Claude window whose reset has passed since the last run', async () => {
  const now = Date.parse('2027-01-15T10:00:00Z');
  recordClaudeLimits(
    'claude-provider',
    new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.9',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(now / 1000) - 60),
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor(now / 1000) + 3600),
    }),
    now - 3_600_000,
  );

  expect(claudeLimits('claude-provider', now)).toEqual({
    fiveHour: null,
    weekly: { usedPercent: 50, resetsAt: new Date(now + 3_600_000).toISOString() },
  });
});

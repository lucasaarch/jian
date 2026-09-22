import { modelSchema } from '@jian/contracts';
import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  anthropicCredential,
  CLAUDE_CODE_IDENTITY,
  withClaudeCodeIdentity,
} from '../src/providers/claude-subscription.js';
import { resolveModel } from '../src/providers/models.js';

describe('providers', () => {
  it.each(['openai', 'anthropic', 'google', 'openai-compatible'] as const)(
    'resolves %s without using another profile’s default',
    async (provider) => {
      const config = modelSchema.parse({
        provider,
        modelId: 'chosen-model',
        apiKeyEnv: 'JIAN_PROVIDER_A',
        ...(provider === 'openai-compatible' ? { baseURL: 'http://localhost:11434/v1' } : {}),
      });

      const model = await resolveModel(config, { JIAN_PROVIDER_A: 'test-only' });

      expect(typeof model).toBe('object');

      if (typeof model !== 'string') {
        expect(model.modelId).toBe('chosen-model');
      }
    },
  );

  it('does not fall back to a global key if the selected credential is absent', async () => {
    await expect(
      resolveModel(
        { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_MISSING' },
        { OPENAI_API_KEY: 'other-profile-secret' },
      ),
    ).rejects.toThrow('Provider key is not configured');
  });
});

it('rejects a compatible provider without an endpoint before making a request', async () => {
  await expect(
    resolveModel(
      { provider: 'openai-compatible', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_LOCAL' },
      { JIAN_PROVIDER_LOCAL: 'local' },
    ),
  ).rejects.toThrow('baseURL is required for compatible providers');
});

it('accepts an explicitly resolved vault key without consulting host environment', async () => {
  const model = await resolveModel(
    {
      provider: 'openai',
      modelId: 'chosen-model',
      providerId: '00000000-0000-4000-8000-000000000001',
    },
    {},
    undefined,
    'dummy-vault-key',
  );

  if (typeof model !== 'string') {
    expect(model.modelId).toBe('chosen-model');
  }
});

it('presents a Claude subscription token as Claude Code, and a key as a key', async () => {
  let headers = new Headers();
  const fetcher: typeof fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } },
      { status: 400 },
    );
  };

  // `claude setup-token` issues this shape. Sent as a key it 401s; sent as a bare bearer it
  // 429s; Anthropic accepts it only from something presenting itself as Claude Code.
  const subscription = await resolveModel(
    { provider: 'anthropic', modelId: 'test', apiKeyEnv: 'ANTHROPIC_API_TOKEN' },
    { ANTHROPIC_API_TOKEN: 'sk-ant-oat01-synthetic' },
    fetcher,
  );

  await expect(
    generateText({ model: subscription, prompt: 'Hi', maxRetries: 0 }),
  ).rejects.toThrow();

  expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-synthetic');
  expect(headers.has('x-api-key')).toBe(false);
  expect(headers.get('anthropic-beta')).toContain('oauth-2025-04-20');
  expect(headers.get('anthropic-beta')).toContain('claude-code-20250219');
  expect(headers.get('user-agent')).toMatch(/^claude-cli\/\d/);

  // The same variable holding a real key is still a key: the shape decides, not the name.
  const key = await resolveModel(
    { provider: 'anthropic', modelId: 'test', apiKeyEnv: 'ANTHROPIC_API_TOKEN' },
    { ANTHROPIC_API_TOKEN: 'sk-ant-api03-synthetic' },
    fetcher,
  );

  await expect(generateText({ model: key, prompt: 'Hi', maxRetries: 0 })).rejects.toThrow();

  expect(headers.get('x-api-key')).toBe('sk-ant-api03-synthetic');
  expect(headers.has('authorization')).toBe(false);
});

it('sends the Claude Code identity as a system block of its own', async () => {
  let sent: { system?: unknown } = {};
  const fetcher: typeof fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as { system?: unknown };

    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } },
      { status: 400 },
    );
  };

  const model = await resolveModel(
    { provider: 'anthropic', modelId: 'test', apiKeyEnv: 'ANTHROPIC_API_TOKEN' },
    { ANTHROPIC_API_TOKEN: 'sk-ant-oat01-synthetic' },
    fetcher,
  );

  await expect(
    generateText({
      model,
      system: withClaudeCodeIdentity('Você é Zero Two.'),
      prompt: 'Oi',
      maxRetries: 0,
    }),
  ).rejects.toThrow();

  // Measured against the real account: the identity appended to the profile's own block is
  // refused, and the same text split in two is accepted.
  expect(sent.system).toEqual([
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
    { type: 'text', text: 'Você é Zero Two.' },
  ]);
});

describe('anthropic credentials', () => {
  it('sends what the owner declared, whatever the credential looks like', () => {
    expect(anthropicCredential('subscription', undefined, 'sk-ant-api03-xyz')).toBe('subscription');
    expect(anthropicCredential('key', 'ANTHROPIC_API_TOKEN', 'whatever')).toBe('key');
  });

  it('reads the prefix before the variable it arrived in', () => {
    expect(anthropicCredential(undefined, 'ANTHROPIC_API_TOKEN', 'sk-ant-api03-xyz')).toBe('key');
    expect(anthropicCredential(undefined, 'ANTHROPIC_API_KEY', 'sk-ant-oat01-xyz')).toBe(
      'subscription',
    );
  });

  it('treats the token variable as the bearer one and anything else as a key', () => {
    expect(anthropicCredential(undefined, 'ANTHROPIC_API_TOKEN', 'opaque')).toBe('subscription');
    expect(anthropicCredential(undefined, 'ANTHROPIC_API_KEY', 'opaque')).toBe('key');
    expect(anthropicCredential(undefined, undefined, undefined)).toBe('key');
  });
});

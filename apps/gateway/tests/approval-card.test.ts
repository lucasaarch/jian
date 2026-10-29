import { modelSchema } from '@jian/contracts';
import { generateText, Output } from 'ai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { plainDescription } from '../src/agent/guard.js';
import { cardOptions } from '../src/agent/runtime.js';
import { withClaudeCodeIdentity } from '../src/providers/claude-subscription.js';
import { resolveModel } from '../src/providers/models.js';

it('asks a model that always thinks for as little as it takes, and nothing it refuses', async () => {
  let body: Record<string, unknown> = {};
  let beta = '';
  const fetcher: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body ?? '{}'));
    beta = new Headers(init?.headers).get('anthropic-beta') ?? '';
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } },
      { status: 400 },
    );
  };
  // A Claude subscription token, the way the owner's Opus 5.5 is reached.
  const config = modelSchema.parse({
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    apiKeyEnv: 'ANTHROPIC_API_TOKEN',
  });
  const model = await resolveModel(
    config,
    { ANTHROPIC_API_TOKEN: 'sk-ant-oat01-synthetic' },
    fetcher,
  );

  await expect(
    generateText({
      model,
      system: withClaudeCodeIdentity('Write the card.'),
      prompt: '{}',
      output: Output.object({ schema: z.object({ title: z.string() }) }),
      providerOptions: cardOptions(config),
      maxRetries: 0,
      maxOutputTokens: 2000,
    }),
  ).rejects.toThrow();

  expect(body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
  // Opus 5.5 answers 400 to each of these.
  expect(body).not.toHaveProperty('tool_choice');
  expect(body).not.toHaveProperty('temperature');
  expect(body.thinking).not.toEqual({ type: 'disabled' });
  expect(body.max_tokens).toBe(2000);
  expect(beta).toContain('oauth-2025-04-20');
});

it('leaves the effort alone where a model has no such setting', () => {
  const older = modelSchema.parse({
    provider: 'anthropic',
    modelId: 'claude-3-haiku',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  });
  const plain = modelSchema.parse({
    provider: 'openai',
    modelId: 'gpt-4o',
    apiKeyEnv: 'OPENAI_API_KEY',
  });

  expect(cardOptions(older)).toBeUndefined();
  expect(cardOptions(plain)).toBeUndefined();
});

it('writes a readable card when the model could not', () => {
  expect(
    plainDescription({
      toolName: 'run_command',
      kind: 'machine',
      input: { command: 'git clone https://example.com/repo.git', timeoutMs: 120000 },
    }),
  ).toEqual({
    title: 'Run a command',
    detail: 'git clone https://example.com/repo.git',
    confirmLabel: 'Run',
  });
  expect(
    plainDescription({ toolName: 'edit_file', kind: 'machine', input: { path: '/w/app.ts' } }),
  ).toMatchObject({ title: 'Edit a file', detail: '/w/app.ts', confirmLabel: 'Edit' });
  expect(
    plainDescription(
      { toolName: 'mcp__github_create_issue_1a2b3c4d', kind: 'service', input: { title: 'Bug' } },
      { server: 'github', tool: 'create_issue' },
    ),
  ).toMatchObject({
    title: "Use github's create_issue",
    detail: 'title: Bug',
    confirmLabel: 'Approve',
  });
});

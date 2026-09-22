import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { mockModel } from './helpers/model.js';
import { events } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
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

async function fixture() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { title: 'Mac' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Remember the deployment time',
    requestKey: 'one',
  });

  return { services, profile, session, run };
}

describe('agent runtime', () => {
  it('refreshes shared context between real SDK tool-loop steps', async () => {
    const { services, profile, session, run } = await fixture();
    let step = 0;

    const model = mockModel({
      doGenerate: async (options) => {
        step++;

        if (step === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'remember',
                input: JSON.stringify({
                  key: 'deployment',
                  content: 'Deploy at 21:00',
                  expectedVersion: 0,
                }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }

        const current = JSON.stringify(options.prompt.filter((m) => m.role === 'system'));

        return answer(
          current.includes('Deploy at 21:00')
            ? 'Saved: deploy at 21:00.'
            : 'I lost the shared context.',
        );
      },
    });

    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    const completed = await services.runs.run(profile.id, run.id);

    expect(completed.status).toBe('completed');
    expect(completed.output).toBe('Saved: deploy at 21:00.');
    expect((await services.memories.memories(profile.id))[0]?.sourceSessionId).toBe(session.id);

    const other = await services.sessions.createSession(profile.id, { title: 'Telegram' });

    const otherRun = await services.runs.submit(profile.id, other.id, {
      text: 'When was the deployment?',
      requestKey: 'two',
    });

    expect((await services.contexts.context(otherRun)).system).toContain('Deploy at 21:00');

    expect(
      (await events(services.store, profile.id, 0)).filter(
        (e) => e.type === 'run.step' && (e.data as { phase: string }).phase === 'step-completed',
      ),
    ).toHaveLength(2);
  });

  it('persists a safe failure without leaking provider credentials', async () => {
    const { services, profile, run } = await fixture();

    const model = mockModel({
      doGenerate: async () => {
        throw new Error('Bearer secret-api-key');
      },
    });

    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    const result = await services.runs.run(profile.id, run.id);

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('secret-api-key');

    expect(JSON.stringify(await events(services.store, profile.id, 0))).not.toContain(
      'secret-api-key',
    );
  });

  it('does not execute a cancelled or already claimed run', async () => {
    const { services, profile, run } = await fixture();

    await services.runs.cancel(profile.id, run.id);

    await new AgentRuntime(services, () => {
      throw new Error('must not resolve');
    }).execute(profile.id, run.id);

    expect((await services.runs.run(profile.id, run.id)).status).toBe('cancelled');
  });

  it('bounds context without dropping the newest user message', async () => {
    const { services, profile, run } = await fixture();

    for (let i = 0; i < 20; i++) {
      await services.memories.remember(profile.id, {
        key: `memory-${i}`,
        content: 'x'.repeat(4000),
        expectedVersion: 0,
      });
    }

    const context = await services.contexts.context(run);

    expect(context.system.length).toBeLessThan(24_000);
    expect(context.messages.at(-1)?.content).toBe('Remember the deployment time');
  });
});

it('resolves a provider key from the installation vault and keeps it out of durable events', async () => {
  const { services, profile } = await fixture();
  const vaultSecret = 'vault"\\\nsecret';

  const provider = await services.providers.createProvider({
    name: 'Model',
    kind: 'openai',
    secret: vaultSecret,
  });

  const updated = await services.profiles.updateProfile(profile.id, {
    expectedVersion: profile.version,
    model: { provider: 'openai', modelId: 'test', providerId: provider.id },
  });

  const session = await services.sessions.createSession(updated.id, { title: 'Vault' });
  const run = await services.runs.submit(updated.id, session.id, {
    text: 'Hello',
    requestKey: 'vault',
  });
  let resolvedKey: string | undefined;
  const model = mockModel({ doGenerate: async () => answer(`Hello ${vaultSecret}`) });

  await new AgentRuntime(
    services,
    (_config, _env, _fetch, key) => {
      resolvedKey = key;

      return model;
    },
    { gatewayVault: services.gatewayVault },
  ).execute(updated.id, run.id);

  expect(resolvedKey).toBe(vaultSecret);

  const finished = await services.runs.run(updated.id, run.id);

  expect(finished.status).toBe('completed');
  expect(finished.output).toBe('Hello [REDACTED]');

  expect(JSON.stringify(await events(services.store, updated.id, 0))).not.toContain(
    JSON.stringify(vaultSecret).slice(1, -1),
  );
});

it('stops a run after its cumulative token cap without making another model call', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    ...input,
    contextPolicy: { maxRunTokens: 32000 },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Budget' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'budget',
  });
  let calls = 0;

  const model = mockModel({
    doGenerate: async () => {
      calls++;

      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `call-${calls}`,
            toolName: 'list_activities',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: {
          inputTokens: { total: 32000, noCache: 32000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 300, text: 300, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).usage).toEqual({
    inputTokens: 32000,
    outputTokens: 300,
    steps: 1,
  });

  expect(calls).toBe(1);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('failed');
});

it('uses conservative estimates when a provider omits usage counters', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    ...input,
    contextPolicy: { maxRunTokens: 32000 },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Missing usage' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Continue',
    requestKey: 'missing-usage',
  });

  let calls = 0;

  const absentUsage = {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  } as unknown as typeof usage;

  const model = mockModel({
    doGenerate: async () => {
      calls++;

      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `unknown-${calls}`,
            toolName: 'list_activities',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: absentUsage,
        warnings: [],
      };
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);

  expect(finished.status).toBe('failed');
  expect(calls).toBeLessThan(12);
  expect(finished.usage?.inputTokens).toBeGreaterThan(0);
  expect(finished.error).toContain('token budget');
});

it('reports a safe context-budget error when required prompt content cannot fit', async () => {
  const services = await testServices();

  const profile = await services.profiles.createProfile({
    ...input,
    instructions: 'x'.repeat(8000),
    // The smallest legal budget that cannot hold the tool definitions and the prompt.
    contextPolicy: { inputTokens: 16000, outputTokens: 15000 },
  });

  const session = await services.sessions.createSession(profile.id, { title: 'Budget' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hi',
    requestKey: 'too-large',
  });
  let calls = 0;

  const model = mockModel({
    doGenerate: async () => {
      calls++;

      return answer('Unexpected.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);

  expect(calls).toBe(0);
  expect(finished.status).toBe('failed');
  expect(finished.error).toContain('Context budget exceeded');
  expect(finished.error).toContain('Tool definitions cost');
  expect(finished.error).not.toContain('credential');
});

it('does not mark a local validation failure as an uncertain external effect', async () => {
  const { services, profile, run } = await fixture();
  let calls = 0;

  const model = mockModel({
    doGenerate: async () => {
      calls++;

      if (calls === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'bad-version',
              toolName: 'remember',
              input: JSON.stringify({ key: 'test', content: 'Dummy', expectedVersion: 99 }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      return answer('I will ask for the current version.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  expect(calls).toBe(2);
});

it('stores a large tool output and sends only a bounded reference to the model', async () => {
  const { services, profile, run } = await fixture();

  for (let i = 0; i < 5; i++) {
    await services.memories.remember(profile.id, {
      key: `large-${i}`,
      content: `result-${i}:${'x'.repeat(3900)}`,
      expectedVersion: 0,
    });
  }

  let capturedOutput: unknown;
  let secondPrompt = '';
  let step = 0;

  const model = mockModel({
    doGenerate: async (options) => {
      step++;

      if (step === 1) {
        return {
          content: [
            { type: 'tool-call', toolCallId: 'large', toolName: 'read_memories', input: '{}' },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      secondPrompt = JSON.stringify(options.prompt);

      return answer('I found the artifact.');
    },
  });

  await new AgentRuntime(services, () => model, {
    storeArtifact: async (_run, _toolName, output) => {
      capturedOutput = output;

      return {
        artifactId: '00000000-0000-4000-8000-000000000001',
        bytes: JSON.stringify(output).length,
      };
    },
  }).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  expect(JSON.stringify(capturedOutput)).toContain('result-0:');
  expect(secondPrompt).toContain('00000000-0000-4000-8000-000000000001');
  expect(secondPrompt).not.toContain('x'.repeat(3900));

  expect(JSON.stringify(await services.lifecycle.checkpoints(profile.id, run.id))).toContain(
    '00000000-0000-4000-8000-000000000001',
  );

  expect(JSON.stringify(await events(services.store, profile.id, 0))).not.toContain(
    'x'.repeat(3900),
  );
});

it('redacts an escaped host credential from tool prompts, artifacts, checkpoints and final output', async () => {
  const secret = 'quote"\\\nline';
  const escaped = JSON.stringify(secret).slice(1, -1);
  const previous = process.env.JIAN_PROVIDER_TEST;

  process.env.JIAN_PROVIDER_TEST = secret;

  try {
    const { services, profile, run } = await fixture();

    await services.memories.remember(profile.id, {
      key: 'hidden',
      content: `${secret}${'x'.repeat(3800)}`,
      expectedVersion: 0,
    });

    let prompt = '';
    let artifact: unknown;
    let step = 0;

    const model = mockModel({
      doGenerate: async (options) => {
        step++;

        if (step === 1) {
          return {
            content: [
              { type: 'tool-call', toolCallId: 'read', toolName: 'read_memories', input: '{}' },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }

        prompt = JSON.stringify(options.prompt);

        return answer(`Echo: ${secret} | ${escaped}`);
      },
    });

    await new AgentRuntime(services, () => model, {
      storeArtifact: async (_run, _toolName, output) => {
        artifact = output;

        return {
          artifactId: '00000000-0000-4000-8000-000000000001',
          bytes: JSON.stringify(output).length,
        };
      },
    }).execute(profile.id, run.id);

    const result = await services.runs.run(profile.id, run.id);

    const durable = JSON.stringify({
      artifact,
      checkpoints: await services.lifecycle.checkpoints(profile.id, run.id),
      events: await events(services.store, profile.id, 0),
      output: result.output,
    });

    expect(result.status).toBe('completed');
    expect(prompt).not.toContain(escaped);
    expect(durable).not.toContain(escaped);
    expect(durable).toContain('[REDACTED]');
    expect(result.output).toBe('Echo: [REDACTED] | [REDACTED]');
  } finally {
    if (previous === undefined) {
      delete process.env.JIAN_PROVIDER_TEST;
    } else {
      process.env.JIAN_PROVIDER_TEST = previous;
    }
  }
});

it('creates a child profile without inheriting provider access', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ ...input, allowSelfManagement: true });
  const session = await services.sessions.createSession(profile.id, { title: 'Parent' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Create a child',
    requestKey: 'child',
  });

  let step = 0;

  const model = mockModel({
    doGenerate: async () => {
      step++;

      if (step === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'child',
              toolName: 'create_profile',
              input: JSON.stringify({ name: 'Child', instructions: 'Help.' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      return answer('Created.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const child = (await services.profiles.profiles()).find(
    (candidate) => candidate.name === 'Child',
  );

  expect(child?.model.apiKeyEnv).toBeUndefined();
  expect(child?.model.providerId).toBeUndefined();
  expect(child?.allowSelfManagement).toBe(false);
});

it('does not report completion when the agent exhausts its tool budget', async () => {
  const { services, profile, run } = await fixture();
  let calls = 0;

  const model = mockModel({
    doGenerate: async () => ({
      content: [
        { type: 'text', text: 'Still working.' },
        {
          type: 'tool-call',
          toolCallId: `call-${++calls}`,
          toolName: 'list_activities',
          input: '{}',
        },
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
      usage,
      warnings: [],
    }),
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('failed');

  expect(
    (await services.sessions.messages(profile.id, run.sessionId)).filter(
      (m) => m.role === 'assistant',
    ),
  ).toHaveLength(0);
});

it('versions self-managed skills without accepting new capability grants', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ ...input, allowSelfManagement: true });
  const session = await services.sessions.createSession(profile.id, { title: 'Skills' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Save a release skill',
    requestKey: 'skill',
  });

  let calls = 0;

  const model = mockModel({
    doGenerate: async () => {
      calls += 1;

      if (calls === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'skill',
              toolName: 'update_skills',
              input: JSON.stringify({
                expectedVersion: 1,
                skills: [
                  {
                    name: 'release',
                    description: 'Release checklist',
                    instructions: 'Confirm tests before release.',
                  },
                ],
              }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      return answer('Skill saved.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');

  const updated = await services.profiles.profile(profile.id);

  expect(updated.version).toBe(2);
  expect(updated.skills[0]?.name).toBe('release');
  expect(updated.model).toEqual(profile.model);
  expect(updated.mcpServers).toEqual([]);
});

it('tells the owner what the provider answered instead of a generic failure', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Limite' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Oi',
    requestKey: 'rate-limited',
  });

  // What a subscription answers once its window is spent: a status, and a body that says
  // nothing. The status is the part worth repeating to the owner.
  const refused = Object.assign(new Error('Error'), { statusCode: 429, responseBody: '{}' });

  const runtime = new AgentRuntime(services, async () => {
    throw refused;
  });

  await runtime.execute(profile.id, run.id);

  const failed = await services.runs.run(profile.id, run.id);

  expect(failed.status).toBe('failed');
  expect(failed.error).toContain('rate limiting');
});

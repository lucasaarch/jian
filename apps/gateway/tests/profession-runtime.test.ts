import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { tool } from 'ai';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentRuntime } from '../src/agent/runtime.js';
import { workspacesRoot } from '../src/agent/workspace.js';
import type { Media } from '../src/media/service.js';
import { profiles } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const answer = () => ({
  content: [{ type: 'text' as const, text: 'Hello!' }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});

async function fixture(
  professionId: 'developer' | 'attendant' | null = 'attendant',
  allowWebSearch = false,
) {
  const services = await testServices();
  const created = await services.profiles.createProfile({
    name: 'Support',
    instructions: 'Help.',
    allowWebSearch,
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  // Test-only trusted classification. Shipping APIs deliberately cannot do this yet.
  await services.store.db.update(profiles).set({ professionId }).where(eq(profiles.id, created.id));
  const profile = await services.profiles.updateProfile(created.id, {
    expectedVersion: created.version,
    name: 'Support',
  });
  const session = await services.sessions.gatewaySession(profile.id);
  const run = await services.runs.submit(
    profile.id,
    session.id,
    { text: 'Hello', requestKey: 'hello' },
    { ownerMessage: true },
  );
  return { services, profile, run };
}

it('answers as a classified attendant without exposing machine tools or preparing a workspace', async () => {
  const { services, profile, run } = await fixture();
  let called = false;
  const model = mockModel({
    doGenerate: async (options) => {
      called = true;
      const names = options.tools?.map((entry) => entry.name) ?? [];
      expect(names).not.toContain('run_command');
      expect(names).not.toContain('create_ssh_key');
      expect(names).not.toContain('ask_agent');
      expect(names).not.toContain('spawn_subagent');
      expect(JSON.stringify(options.tools)).not.toContain('"shell"');
      expect(JSON.stringify(options.prompt)).not.toContain('Never use ssh-keygen');
      return answer();
    },
  });
  await expect(access(join(workspacesRoot(), profile.id))).rejects.toThrow();
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect(called).toBe(true);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  await expect(access(join(workspacesRoot(), profile.id))).rejects.toThrow();
});

it('rechecks a loaded tool after revocation while the model was generating a forged call', async () => {
  const { services, profile, run } = await fixture('developer', true);
  const effect = vi.fn(async () => 'Fetched');
  let step = 0;
  const call = (toolName: string, input: unknown) => ({
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: `call-${step}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
    usage,
    warnings: [],
  });
  const model = mockModel({
    doGenerate: async (options) => {
      if (step++ === 0) return call('load_tools', { groups: ['web'] });
      if (step === 2) {
        expect(options.tools?.map((entry) => entry.name)).toContain('fetch_url');
        await services.profiles.updateProfile(profile.id, {
          expectedVersion: profile.version,
          allowWebSearch: false,
        });
        return call('fetch_url', {});
      }
      return answer();
    },
  });
  await new AgentRuntime(
    {
      ...services,
      web: { tools: () => ({ fetch_url: tool({ inputSchema: z.object({}), execute: effect }) }) },
    },
    () => model,
  ).execute(profile.id, run.id);
  expect(step).toBeGreaterThanOrEqual(2);
  expect(effect).not.toHaveBeenCalled();
});

it('rechecks initially legacy work after Decisions awaits, before the executor', async () => {
  const { services, profile, run } = await fixture(null);
  const effect = vi.fn(async () => 'Sent');
  const judged = vi.fn(async () => {
    // Simulate future trusted initial classification while an action approval is pending.
    await services.store.db
      .update(profiles)
      .set({ professionId: 'attendant' })
      .where(eq(profiles.id, profile.id));
    return undefined;
  });
  let step = 0;
  const model = mockModel({
    doGenerate: async () => {
      const input =
        step++ === 0
          ? { toolName: 'load_tools', input: { groups: ['media'] } }
          : { toolName: 'send_file', input: { source: 'path', path: '/not-opened' } };
      return step > 2
        ? answer()
        : {
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: `call-${step}`,
                toolName: input.toolName,
                input: JSON.stringify(input.input),
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
            usage,
            warnings: [],
          };
    },
  });
  await new AgentRuntime(
    {
      ...services,
      decisions: { judge: judged, ask: vi.fn() },
      media: {
        prepare: async () => {},
        // Deliberately partial provider: only the counting executor under test is registered.
        tools: () =>
          ({
            send_file: tool({
              inputSchema: z.object({
                source: z.enum(['path', 'content', 'mediaId']).optional(),
                path: z.string().optional(),
              }),
              execute: effect,
            }),
          }) as unknown as ReturnType<Media['tools']>,
      },
    },
    () => model,
  ).execute(profile.id, run.id);
  expect(judged).toHaveBeenCalledTimes(1);
  expect(effect).not.toHaveBeenCalled();
  expect((await services.runs.run(profile.id, run.id)).status).toBe('failed');
});

it('fails closed before model or workspace use for a classified historical run without authority', async () => {
  const { services, profile, run } = await fixture();
  const { runs } = await import('../src/storage/schema.js');
  await services.store.db.update(runs).set({ authority: null }).where(eq(runs.id, run.id));
  const factory = vi.fn(() => mockModel({ doGenerate: async () => answer() }));
  await new AgentRuntime(services, factory).execute(profile.id, run.id);
  expect(factory).not.toHaveBeenCalled();
  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.status).toBe('failed');
  expect(finished.error).toMatch(/authority|review/i);
  await expect(access(join(workspacesRoot(), profile.id))).rejects.toThrow();
});

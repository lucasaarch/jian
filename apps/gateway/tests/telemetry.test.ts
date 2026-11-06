import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { checkpoints, runs } from '../src/storage/schema.js';
import { REPORT_EVERY_MS, Telemetry } from '../src/telemetry/service.js';
import { testServices } from './helpers/services.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const destination = { key: 'phc_synthetic_key', host: 'https://posthog.example.test' };

/** An installation with a little of everything, much of it named after a fictional client. */
async function installation() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Acme Assistant',
    instructions: 'Help Acme.',
    model: { provider: 'openai', modelId: 'gpt-test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Acme launch' });
  await services.mcp.replace({
    servers: [
      { name: 'linear_acme', url: 'https://mcp.linear.app/mcp', auth: 'oauth' },
      { name: 'acme_internal', url: 'https://mcp.acme.example.test/mcp' },
    ],
  });
  const turn = async (
    key: string,
    status: 'completed' | 'failed',
    error?: string,
    model: Record<string, unknown> = {
      provider: 'openai',
      modelId: 'gpt-test',
      reasoningEffort: 'high',
    },
  ) => {
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'The secret Acme launch plan',
      requestKey: key,
    });
    await services.store.db
      .update(runs)
      .set({
        status,
        ...(error ? { error } : {}),
        model: model as never,
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cachedInputTokens: 600,
          cacheWriteTokens: 200,
          estimated: false,
          steps: 2,
        },
        createdAt: new Date(NOW - 3600_000),
      })
      .where(eq(runs.id, run.id));
    return run;
  };
  const done = await turn('one', 'completed');
  await turn('two', 'failed', 'HTTP 429: the Acme workspace quota is spent');
  // A model on an endpoint of the owner's own: its name is theirs.
  await turn('three', 'completed', undefined, {
    provider: 'openai-compatible',
    modelId: 'acme-finetune',
  });
  const step = (data: unknown) =>
    services.store.db.insert(checkpoints).values({
      id: randomUUID(),
      profileId: profile.id,
      runId: done.id,
      data,
      createdAt: new Date(NOW - 3000_000),
    });
  await step({ phase: 'tool-started', toolName: 'run_command' });
  await step({
    phase: 'tool-started',
    toolName: 'linear_acme_create_issue_1a2b3c4d',
    mcp: { server: 'linear_acme' },
  });
  // A server's tool the checkpoint could not trace back: its name carries the server's.
  await step({ phase: 'tool-started', toolName: 'acme_internal_search_9f8e7d6c' });
  await step({ phase: 'compaction-failed', reason: 'The Acme summary was cut off' });
  return services;
}

function posting(status = 200) {
  const sent: Array<{ url: string; body: string }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body) });
    return new Response('{}', { status });
  }) as typeof globalThis.fetch;
  return { sent, fetcher };
}

const telemetry = (
  services: Awaited<ReturnType<typeof testServices>>,
  fetcher: typeof globalThis.fetch,
  overrides: Partial<ConstructorParameters<typeof Telemetry>[1]> = {},
  at = () => NOW,
) =>
  new Telemetry(services.store, {
    env: {},
    fetcher,
    version: '1.6.0',
    mode: 'server',
    role: 'all',
    clock: at,
    destination,
    ...overrides,
  });

it('reports what the installation is and did, counted, and nothing anyone wrote or named', async () => {
  const services = await installation();
  const { sent, fetcher } = posting();

  expect(await telemetry(services, fetcher).reportIfDue()).toBe(true);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe('https://posthog.example.test/batch/');
  const { api_key, batch } = JSON.parse(sent[0]?.body ?? '{}');
  expect(api_key).toBe(destination.key);
  const [active, usage] = batch;
  expect(active.event).toBe('gateway_active');
  expect(active.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(usage.distinct_id).toBe(active.distinct_id);
  expect(active.properties).toMatchObject({
    version: '1.6.0',
    agents: 1,
    mcp_apps: { linear: 1 },
    mcp_custom_servers: 1,
    $process_person_profile: false,
  });
  expect(usage.properties).toMatchObject({
    runs: 3,
    run_statuses: { completed: 2, failed: 1 },
    tokens: { input: 3000, cached: 1800, cache_write: 600, output: 300 },
    models: { 'openai:gpt-test': 2, 'openai-compatible:custom': 1 },
    failures: { 'rate-limit': 1 },
    tools: { run_command: 1 },
    mcp_app_calls: { linear: 1 },
    context: { compaction_failed: 1 },
  });

  // The agent's, the conversation's and the servers' names, what was asked, and why it failed.
  expect(sent[0]?.body.toLowerCase()).not.toContain('acme');
  expect(sent[0]?.body).not.toContain('secret');
});

it('reports once a day, under the same id', async () => {
  const services = await installation();
  const { sent, fetcher } = posting();
  let now = NOW;
  const clock = () => now;

  expect(await telemetry(services, fetcher, {}, clock).reportIfDue()).toBe(true);
  now += REPORT_EVERY_MS - 60_000;
  expect(await telemetry(services, fetcher, {}, clock).reportIfDue()).toBe(false);
  now += 120_000;
  expect(await telemetry(services, fetcher, {}, clock).reportIfDue()).toBe(true);

  const ids = sent.map((item) => JSON.parse(item.body).batch[0].distinct_id);
  expect(sent).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

it('sends nothing when the owner, the host or a development build says no', async () => {
  const services = await installation();
  const { sent, fetcher } = posting();

  const off = telemetry(services, fetcher);
  expect(await off.state()).toEqual({ enabled: true, source: 'default' });
  await off.set(false);
  expect(await off.state()).toEqual({ enabled: false, source: 'setting' });
  expect(await off.reportIfDue()).toBe(false);
  await off.set(true);

  for (const env of [{ DO_NOT_TRACK: '1' }, { JIAN_TELEMETRY: 'off' }]) {
    const host = telemetry(services, fetcher, { env });
    expect(await host.state()).toEqual({ enabled: false, source: 'environment' });
    expect(await host.reportIfDue()).toBe(false);
  }
  expect(await telemetry(services, fetcher, { version: undefined }).reportIfDue()).toBe(false);

  expect(sent).toHaveLength(0);
});

it('tries again later when the report could not be delivered', async () => {
  const services = await installation();
  const down = posting(503);

  expect(await telemetry(services, down.fetcher).reportIfDue()).toBe(false);

  const up = posting();
  expect(await telemetry(services, up.fetcher).reportIfDue()).toBe(true);
  expect(down.sent).toHaveLength(1);
  expect(up.sent).toHaveLength(1);
});

it('turns telemetry on and off from the gateway settings', async () => {
  const services = await testServices();
  services.settings.useTelemetry(telemetry(services, posting().fetcher));

  expect((await services.settings.read()).telemetry).toEqual({ enabled: true, source: 'default' });
  const after = await services.settings.update({ telemetry: false });
  expect(after.telemetry).toEqual({ enabled: false, source: 'setting' });
});

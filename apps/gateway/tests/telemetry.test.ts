import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import {
  artifactFolders,
  channels,
  checkpoints,
  devices,
  emailDomains,
  emailLog,
  memories,
  messages,
  projects,
  pullWatchers,
  pushSubscriptions,
  runs,
  scheduleRuns,
  schedules,
  sessionArtifacts,
  sessionArtifactVersions,
  sessions,
  sessionWorktrees,
  skills,
} from '../src/storage/schema.js';
import { REPORT_EVERY_MS, Telemetry } from '../src/telemetry/service.js';
import { testServices } from './helpers/services.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const destination = { key: 'phc_synthetic_key', host: 'https://posthog.example.test' };
const before = (ms: number) => new Date(NOW - ms);

/** An installation with a little of everything, much of it named after a fictional client. */
async function installation() {
  const services = await testServices();
  const db = services.store.db;
  const profile = await services.profiles.createProfile({
    name: 'Acme Assistant',
    instructions: 'Help Acme.',
    model: { provider: 'openai', modelId: 'gpt-test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const profileId = profile.id;
  const panel = await services.sessions.createGatewaySession(profileId, {});
  const telegram = await services.sessions.createSession(profileId, {
    title: 'Acme on Telegram',
    channel: 'telegram',
  });
  // A channel an API caller made up: its name is theirs.
  const crm = await services.sessions.createSession(profileId, {
    title: 'Acme CRM hook',
    channel: 'acme-crm',
  });
  await db
    .update(sessions)
    .set({ title: 'Acme launch', protection: 'auto' })
    .where(eq(sessions.id, panel.id));
  await db
    .update(sessions)
    .set({ remoteMachineId: randomUUID() })
    .where(eq(sessions.id, telegram.id));
  await services.mcp.replace({
    servers: [
      { name: 'linear_acme', url: 'https://mcp.linear.app/mcp', auth: 'oauth' },
      { name: 'acme_internal', url: 'https://mcp.acme.example.test/mcp' },
    ],
  });

  const turn = async (
    key: string,
    status: 'completed' | 'failed' | 'interrupted',
    options: {
      sessionId?: string;
      error?: string;
      seconds?: number;
      model?: Record<string, unknown>;
      approval?: Record<string, unknown>;
    } = {},
  ) => {
    const run = await services.runs.submit(profileId, options.sessionId ?? panel.id, {
      text: 'The secret Acme launch plan',
      requestKey: key,
    });
    await db
      .update(runs)
      .set({
        status,
        ...(options.error ? { error: options.error } : {}),
        ...(options.approval ? { approval: options.approval as never } : {}),
        model: (options.model ?? {
          provider: 'openai',
          modelId: 'gpt-test',
          reasoningEffort: 'high',
        }) as never,
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cachedInputTokens: 600,
          cacheWriteTokens: 200,
          estimated: false,
          steps: 2,
        },
        createdAt: before(3600_000),
        updatedAt: before(3600_000 - (options.seconds ?? 5) * 1000),
      })
      .where(eq(runs.id, run.id));
    return run;
  };
  const done = await turn('one', 'completed', {
    seconds: 30,
    approval: {
      id: randomUUID(),
      toolCallId: 'call-1',
      toolName: 'send_email',
      kind: 'message',
      title: 'Email the Acme board',
      detail: 'Sends the Acme plan.',
      confirmLabel: 'Send it',
      request: '{"to":"ceo@acme.example.test"}',
      askedAt: before(3500_000).toISOString(),
      decision: 'approved',
      decidedAt: before(3400_000).toISOString(),
      decidedBy: 'owner',
    },
  });
  await turn('two', 'failed', { error: 'HTTP 429: the Acme workspace quota is spent' });
  // A model on an endpoint of the owner's own: its name is theirs.
  await turn('three', 'completed', {
    seconds: 90,
    model: { provider: 'openai-compatible', modelId: 'acme-finetune' },
  });
  const scheduled = await turn('four', 'completed', { sessionId: telegram.id, seconds: 60 });
  await turn('five', 'failed', {
    sessionId: telegram.id,
    error:
      "The provider takes no call until 2026-11-09 08:00 UTC, in 2 days 20 hours (HTTP 429, rate limited), most likely a subscription's usage limit. Choose another model, or send again then.",
  });
  await turn('six', 'interrupted', {
    error:
      'Stopped: nothing came back from the model or a tool for 5 minutes. Completed steps are saved; inspect them before continuing.',
  });
  const helper = await turn('seven', 'completed', { sessionId: crm.id, seconds: 10 });
  await db
    .update(runs)
    .set({
      subagent: {
        role: 'execute',
        name: 'Acme researcher',
        identity: 'Researches Acme.',
        parentRunId: done.id,
        spawnKey: 'acme-1',
        inputHash: 'a'.repeat(64),
      },
    })
    .where(eq(runs.id, helper.id));

  const step = (data: unknown) =>
    db.insert(checkpoints).values({
      id: randomUUID(),
      profileId,
      runId: done.id,
      data,
      createdAt: before(3000_000),
    });
  await step({ phase: 'tool-started', toolName: 'run_command', input: { command: 'ls /acme' } });
  await step({
    phase: 'tool-started',
    toolName: 'linear_acme_create_issue_1a2b3c4d',
    mcp: { server: 'linear_acme' },
  });
  // A server's tool the checkpoint could not trace back: its name carries the server's.
  await step({ phase: 'tool-started', toolName: 'acme_internal_search_9f8e7d6c' });
  await step({ phase: 'compaction-failed', reason: 'The Acme summary was cut off' });
  await step({
    phase: 'tool-started',
    toolName: 'send_artifact',
    input: { artifactId: randomUUID(), format: 'pdf', caption: 'For the Acme board' },
  });
  await step({ phase: 'tool-started', toolName: 'load_skill', input: { name: 'acme-playbook' } });
  await step({
    phase: 'tool-started',
    toolName: 'load_skill',
    input: { name: 'jian-configuration' },
  });
  await step({ phase: 'tool-failed', toolName: 'run_command', reason: 'No /acme folder' });
  await step({
    phase: 'tool-failed',
    toolName: 'acme_internal_search_9f8e7d6c',
    reason: 'Acme said no',
  });
  await step({ phase: 'model-reconnected', attempts: 3, waitedMs: 2600, recovered: true });
  await step({ phase: 'model-reconnected', attempts: 1, waitedMs: 0, recovered: false });
  await step({
    phase: 'mcp-unavailable',
    servers: [{ name: 'acme_internal' }, { name: 'linear_acme', app: 'linear' }],
  });

  // A deck shared by link, in a folder, changed once by the agent and once by hand.
  const folder = randomUUID();
  await db.insert(artifactFolders).values({ id: folder, profileId, name: 'Acme folder' });
  const deck = randomUUID();
  await db.insert(sessionArtifacts).values({
    id: deck,
    profileId,
    sessionId: panel.id,
    title: 'Acme roadmap',
    type: 'deck',
    version: 3,
    visibility: 'public',
    publicToken: 'acme-public-token',
    folderId: folder,
    createdAt: before(3300_000),
  });
  for (const [version, author] of [
    [1, 'agent'],
    [2, 'agent'],
    [3, 'owner'],
  ] as const) {
    await db.insert(sessionArtifactVersions).values({
      artifactId: deck,
      version,
      author,
      content: `{"title":"Acme slides v${version}"}`,
      createdAt: before(3300_000 - version * 1000),
    });
  }

  // Two people on Telegram and the answer; one each way in the panel; and what the gateway
  // wrote itself to resume a conversation, which no person sent.
  const message = (sessionId: string, role: 'user' | 'assistant', purpose?: 'resume') =>
    db.insert(messages).values({
      id: randomUUID(),
      profileId,
      sessionId,
      role,
      content: 'Acme wants the launch moved',
      ...(purpose ? { purpose } : {}),
      createdAt: before(3200_000),
    });
  await message(telegram.id, 'user');
  await message(telegram.id, 'user');
  await message(telegram.id, 'assistant');
  await message(panel.id, 'user');
  await message(panel.id, 'assistant');
  await message(panel.id, 'user', 'resume');

  await db.insert(memories).values({
    profileId,
    key: 'acme-client',
    content: 'Acme pays late',
    version: 1,
    updatedAt: before(3100_000),
  });
  await db.insert(skills).values({
    name: 'acme-playbook',
    description: 'How Acme likes its reports.',
    instructions: 'Write to Acme formally.',
  });
  const schedule = randomUUID();
  await db.insert(schedules).values({
    id: schedule,
    profileId,
    name: 'Acme digest',
    instruction: 'Summarise Acme news.',
    cron: '0 9 * * *',
    timeZone: 'UTC',
    createdBy: 'owner',
  });
  await db.insert(scheduleRuns).values([
    {
      id: randomUUID(),
      scheduleId: schedule,
      profileId,
      dueAt: before(3600_000),
      runId: scheduled.id,
      createdAt: before(3600_000),
    },
    {
      id: randomUUID(),
      scheduleId: schedule,
      profileId,
      dueAt: before(1800_000),
      error: 'Acme is down',
      createdAt: before(1800_000),
    },
  ]);
  await db.insert(pullWatchers).values({
    id: randomUUID(),
    profileId,
    sessionId: panel.id,
    owner: 'acme',
    repo: 'acme-web',
    number: 7,
    status: 'watching',
    nextPollAt: before(0),
    createdAt: before(2000_000),
  });
  const channel = randomUUID();
  await db.insert(channels).values({
    id: channel,
    profileId,
    type: 'email',
    address: 'agent@acme.example.test',
    webhookTokenHash: 'synthetic-hash',
  });
  for (const direction of ['received', 'received', 'sent'] as const) {
    await db.insert(emailLog).values({
      id: randomUUID(),
      profileId,
      channelId: channel,
      direction,
      address: 'ceo@acme.example.test',
      subject: 'Acme deal',
      text: 'The Acme deal is off',
      createdAt: before(2500_000),
    });
  }
  await db.insert(emailDomains).values({
    id: randomUUID(),
    profileId,
    channelId: channel,
    domain: 'acme.example.test',
    reason: 'Signed up to Acme',
    expiresAt: before(-86_400_000),
  });
  await db.insert(projects).values({
    id: randomUUID(),
    profileId,
    name: 'Acme web',
    repositoryUrl: 'https://github.com/acme/web',
  });
  await db.insert(sessionWorktrees).values({
    id: randomUUID(),
    profileId,
    sessionId: panel.id,
    name: 'acme-fix',
    branch: 'acme/fix',
    base: 'main',
    source: '/home/acme/web',
    path: '/home/acme/web-acme-fix',
    place: 'gateway',
  });
  await db
    .insert(devices)
    .values({ id: randomUUID(), name: 'Acme phone', platform: 'ios', tokenHash: 'synthetic' });
  await db.insert(pushSubscriptions).values({
    endpoint: 'https://push.example.test/acme',
    p256dh: 'synthetic',
    auth: 'synthetic',
  });
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
    channels: { email: 1 },
    artifacts: { deck: 1 },
    artifacts_public: 1,
    artifact_folders: 1,
    projects: 1,
    worktrees_active: 1,
    memories: 1,
    skills: { owner: 1, agent: 0, imported: 0 },
    sessions_by_protection: { auto: 1 },
    devices: 1,
    push_subscriptions: 1,
    email_domains: 1,
    installation_age_days: 0,
    $process_person_profile: true,
    $geoip_disable: true,
  });
  expect(active.properties).not.toHaveProperty('upgraded_from');
  expect(usage.properties).toMatchObject({
    runs: 7,
    run_statuses: { completed: 4, failed: 2, interrupted: 1 },
    tokens: { input: 7000, cached: 4200, cache_write: 1400, output: 700 },
    models: { 'openai:gpt-test': 6, 'openai-compatible:custom': 1 },
    failures: { 'rate-limit': 1, 'usage-limit': 1 },
    interruptions: { stalled: 1 },
    run_origins: { panel: 4, schedule: 1, channel: 1, subagent: 1 },
    run_places: { gateway: 5, machine: 2 },
    run_seconds: { p50: 45, p95: 85.5, max: 90 },
    run_tokens: { p50: 1100, p95: 1100 },
    run_steps: { p50: 2, p95: 2 },
    approvals: { asked: 1, approved: 1, rejected: 0, undecided: 0 },
    sessions_active: { panel: 1, telegram: 1, other: 1 },
    tools: { run_command: 1, send_artifact: 1, load_skill: 2 },
    tool_failures: { run_command: 1 },
    mcp_app_calls: { linear: 1 },
    mcp_unavailable: { custom: 1, linear: 1 },
    artifacts_sent: { pdf: 1 },
    skills_loaded: { custom: 1, 'jian-configuration': 1 },
    context: { compacted: 0, compaction_failed: 1, truncated: 0 },
    model_reconnects: { calls: 2, attempts: 4, waited_seconds: 3, recovered: 1, gave_up: 1 },
    artifacts_created: { deck: 1 },
    artifact_updates: { agent: 1, owner: 1 },
    messages_in: { telegram: 2, panel: 1 },
    messages_out: { telegram: 1, panel: 1 },
    memories_written: 1,
    memories_created: 1,
    schedule_runs: { started: 1, failed: 1, manual: 0 },
    pull_requests_opened: 1,
    email: { received: 2, sent: 1 },
  });
  expect(Object.keys(usage.properties.tool_failures)).toEqual(['run_command']);

  // The installation's profile: the same counts and fixed words, and nothing else.
  expect(Object.keys(active.properties.$set).sort()).toEqual(
    [
      'version',
      'mode',
      'role',
      'os',
      'arch',
      'node',
      'agents',
      'machines',
      'schedules',
      'github_accounts',
      'x_accounts',
      'mcp_custom_servers',
      'providers_count',
      'mcp_apps_count',
      'channels_count',
      'has_whatsapp',
      'has_telegram',
      'has_email',
      'installation_age_days',
    ].sort(),
  );
  expect(active.properties.$set).toMatchObject({
    agents: 1,
    mcp_apps_count: 1,
    channels_count: 1,
    has_email: true,
    has_whatsapp: false,
  });
  expect(active.properties.$set_once).toEqual({
    first_seen: '2026-11-06',
    first_version: '1.6.0',
  });
  expect(usage.properties.$set).toBeUndefined();

  // Every name above (agent, conversations, channel, servers, skill, schedule, folder, Artifact,
  // memory, project, worktree, device, repository), every address and domain, what was asked,
  // what was sent and why anything failed.
  const body = sent[0]?.body.toLowerCase() ?? '';
  expect(body).not.toContain('acme');
  expect(body).not.toContain('secret');
  expect(body).not.toContain('example.test');
  expect(body).not.toContain('crm');
});

it('reports once a day, under the same id, with its age and what it was upgraded from', async () => {
  const services = await installation();
  const { sent, fetcher } = posting();
  let now = NOW;
  const clock = () => now;

  expect(await telemetry(services, fetcher, {}, clock).reportIfDue()).toBe(true);
  now += REPORT_EVERY_MS - 60_000;
  expect(await telemetry(services, fetcher, {}, clock).reportIfDue()).toBe(false);
  now += 120_000;
  expect(await telemetry(services, fetcher, { version: '1.7.0' }, clock).reportIfDue()).toBe(true);
  now += REPORT_EVERY_MS;
  expect(await telemetry(services, fetcher, { version: '1.7.0' }, clock).reportIfDue()).toBe(true);

  const active = sent.map((item) => JSON.parse(item.body).batch[0]);
  expect(sent).toHaveLength(3);
  expect(active[1].distinct_id).toBe(active[0].distinct_id);
  expect(active[1].properties).toMatchObject({ upgraded_from: '1.6.0', installation_age_days: 1 });
  expect(active[1].properties.$set_once).toEqual({
    first_seen: '2026-11-06',
    first_version: '1.7.0',
  });
  expect(active[2].properties).not.toHaveProperty('upgraded_from');
  expect(active[2].properties.installation_age_days).toBe(2);
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

it('tries again later when the report could not be delivered, upgrade included', async () => {
  const services = await installation();
  expect(await telemetry(services, posting().fetcher).reportIfDue()).toBe(true);
  const later = () => NOW + REPORT_EVERY_MS;
  const down = posting(503);

  expect(await telemetry(services, down.fetcher, { version: '1.7.0' }, later).reportIfDue()).toBe(
    false,
  );

  const up = posting();
  expect(await telemetry(services, up.fetcher, { version: '1.7.0' }, later).reportIfDue()).toBe(
    true,
  );
  expect(down.sent).toHaveLength(1);
  expect(up.sent).toHaveLength(1);
  // The upgrade the lost report carried is said again by the one that went out.
  expect(JSON.parse(up.sent[0]?.body ?? '{}').batch[0].properties.upgraded_from).toBe('1.6.0');
});

it('turns telemetry on and off from the gateway settings', async () => {
  const services = await testServices();
  services.settings.useTelemetry(telemetry(services, posting().fetcher));

  expect((await services.settings.read()).telemetry).toEqual({ enabled: true, source: 'default' });
  const after = await services.settings.update({ telemetry: false });
  expect(after.telemetry).toEqual({ enabled: false, source: 'setting' });
});

import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

it('polls GitHub and wakes once when checks complete', async () => {
  let now = Date.parse('2026-10-20T05:00:00.000Z');
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });

  const urls: string[] = [];
  let checkStatus: 'in_progress' | 'completed' = 'in_progress';
  services.subscriptions.useGithub(async (inputUrl) => {
    const url = String(inputUrl);
    urls.push(url);
    if (url.includes('/pulls/38')) {
      return Response.json({
        state: 'open',
        merged: false,
        head: { sha: 'abc123def' },
      });
    }
    if (url.includes('/check-runs')) {
      return Response.json({
        check_runs: [
          {
            name: 'Check',
            status: checkStatus,
            conclusion: checkStatus === 'completed' ? 'success' : null,
          },
        ],
      });
    }
    return new Response('not found', { status: 404 });
  });

  const created = await services.subscriptions.create(
    profile.id,
    {
      name: 'PR 38 Check',
      instruction: 'CI finished — continue the objective.',
      sessionId: session.id,
      source: 'github',
      filter: {
        owner: 'lucasaarch',
        repo: 'jian',
        events: ['check_suite.completed'],
        pullNumber: 38,
        checkName: 'Check',
        pollIntervalSeconds: 30,
      },
      enabled: true,
    },
    'agent',
  );

  expect(created.nextPollAt).toBe('2026-10-20T05:00:00.000Z');
  expect(created.createdBy).toBe('agent');

  await services.subscriptions.pollDue();
  expect(
    (await services.runs.recent(profile.id)).filter((item) =>
      item.requestKey.startsWith(`subscription:${created.id}:`),
    ),
  ).toHaveLength(0);

  const pending = (await services.subscriptions.list(profile.id))[0];
  expect(pending?.lastObservation?.checksCompleted).toBe(false);
  expect(pending?.nextPollAt).toBe('2026-10-20T05:00:30.000Z');

  checkStatus = 'completed';
  now = Date.parse('2026-10-20T05:00:30.000Z');
  await services.subscriptions.pollDue();
  await services.subscriptions.pollDue();

  const wakes = (await services.runs.recent(profile.id)).filter((item) =>
    item.requestKey.startsWith(`subscription:${created.id}:`),
  );
  expect(wakes).toHaveLength(1);
  expect(wakes[0]?.input).toContain('CI finished');
  expect(wakes[0]?.input).toContain('Check conclusion: success');
  expect(wakes[0]?.input).toContain('Changed: checks pending → success');

  const after = (await services.subscriptions.list(profile.id))[0];
  expect(after?.lastWakeAt).toBeDefined();
  expect(after?.lastRunId).toBe(wakes[0]?.id);
  expect(after?.lastObservation?.checksCompleted).toBe(true);
  expect(urls.some((url) => url.includes('/pulls/38'))).toBe(true);
});

it('keeps unchanged polls silent and does not spam while open and green', async () => {
  let now = Date.parse('2026-10-20T16:53:00.000Z');
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });

  let checkStatus: 'in_progress' | 'completed' = 'in_progress';
  let emptyChecks = false;
  services.subscriptions.useGithub(async (inputUrl) => {
    const url = String(inputUrl);
    if (url.includes('/pulls/47')) {
      return Response.json({
        state: 'open',
        merged: false,
        head: { sha: 'deadbeef01' },
      });
    }
    if (url.includes('/check-runs')) {
      if (emptyChecks) return Response.json({ check_runs: [] });
      return Response.json({
        check_runs: [
          {
            name: 'Check',
            status: checkStatus,
            conclusion: checkStatus === 'completed' ? 'success' : null,
          },
        ],
      });
    }
    return new Response('not found', { status: 404 });
  });

  const created = await services.subscriptions.create(
    profile.id,
    {
      name: 'PR 47 Check',
      instruction: 'Tell me when CI finishes; do not merge without authorization.',
      sessionId: session.id,
      source: 'github',
      filter: {
        owner: 'lucasaarch',
        repo: 'jian',
        events: ['check_suite.completed', 'pull_request.closed'],
        pullNumber: 47,
        checkName: 'Check',
        pollIntervalSeconds: 20,
      },
      enabled: true,
    },
    'agent',
  );

  // Steady pending: several ticks must not submit a run.
  for (let i = 0; i < 3; i += 1) {
    await services.subscriptions.pollDue();
    now += 20_000;
  }
  expect(
    (await services.runs.recent(profile.id)).filter((item) =>
      item.requestKey.startsWith(`subscription:${created.id}:`),
    ),
  ).toHaveLength(0);

  checkStatus = 'completed';
  await services.subscriptions.pollDue();
  now += 20_000;

  // After green: empty check-runs flicker + repeated green polls must not wake again.
  emptyChecks = true;
  await services.subscriptions.pollDue();
  now += 20_000;
  emptyChecks = false;
  for (let i = 0; i < 4; i += 1) {
    await services.subscriptions.pollDue();
    now += 20_000;
  }

  const wakes = (await services.runs.recent(profile.id)).filter((item) =>
    item.requestKey.startsWith(`subscription:${created.id}:`),
  );
  expect(wakes).toHaveLength(1);
  expect(wakes[0]?.input).toContain('Changed: checks pending → success');

  const after = (await services.subscriptions.list(profile.id))[0];
  expect(after?.lastObservation?.checksCompleted).toBe(true);
  expect(after?.lastObservation?.checkConclusion).toBe('success');
  expect(after?.lastObservation?.pullState).toBe('open');
});

it('creates a GitHub subscription and wakes once per delivery', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });

  const created = await services.subscriptions.create(
    profile.id,
    {
      name: 'PR CI',
      instruction: 'CI finished — continue the objective.',
      sessionId: session.id,
      source: 'github',
      filter: {
        owner: 'lucasaarch',
        repo: 'jian',
        events: ['check_suite.completed'],
      },
      enabled: true,
    },
    'owner',
  );

  expect(created.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  expect(created.nextPollAt).toBeDefined();
  expect(await services.subscriptions.list(profile.id)).toHaveLength(1);

  const payload = {
    action: 'completed',
    repository: { name: 'jian', owner: { login: 'lucasaarch' } },
    check_suite: { conclusion: 'success' },
  };
  const secret = created.webhookSecret;
  expect(secret).toBeDefined();
  if (!secret) throw new Error('expected webhook secret');
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  const first = await services.subscriptions.receiveGithub(
    created.id,
    {
      'x-hub-signature-256': signature,
      'x-github-event': 'check_suite',
      'x-github-delivery': 'delivery-1',
    },
    raw,
    payload,
  );
  expect(first.accepted).toBe(true);
  expect(first.runId).toBeDefined();
  if (!first.runId) throw new Error('expected wake run');

  const run = await services.runs.run(profile.id, first.runId);
  expect(run.input).toContain('CI finished');
  expect(run.requestKey).toBe(`subscription:${created.id}:delivery-1`);

  const again = await services.subscriptions.receiveGithub(
    created.id,
    {
      'x-hub-signature-256': signature,
      'x-github-event': 'check_suite',
      'x-github-delivery': 'delivery-1',
    },
    raw,
    payload,
  );
  expect(again.runId).toBe(first.runId);
  expect(
    (await services.runs.recent(profile.id)).filter((item) =>
      item.requestKey.startsWith(`subscription:${created.id}:`),
    ),
  ).toHaveLength(1);
});

it('rejects a bad GitHub signature', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  const created = await services.subscriptions.create(
    profile.id,
    {
      name: 'PR merge',
      instruction: 'PR closed.',
      sessionId: session.id,
      source: 'github',
      filter: {
        owner: 'lucasaarch',
        repo: 'jian',
        events: ['pull_request.closed'],
      },
      enabled: true,
    },
    'agent',
  );

  const payload = {
    action: 'closed',
    repository: { name: 'jian', owner: { login: 'lucasaarch' } },
    pull_request: { number: 22 },
  };
  const raw = Buffer.from(JSON.stringify(payload));

  await expect(
    services.subscriptions.receiveGithub(
      created.id,
      {
        'x-hub-signature-256': 'sha256=deadbeef',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-bad',
      },
      raw,
      payload,
    ),
  ).rejects.toMatchObject({ statusCode: 401 });
});

it('isolates subscriptions between profiles', async () => {
  const services = await testServices();
  const a = await services.profiles.createProfile(input);
  const b = await services.profiles.createProfile({ ...input, name: 'Other' });
  const session = await services.sessions.createSession(a.id, { channel: 'api' });
  const created = await services.subscriptions.create(
    a.id,
    {
      name: 'Private',
      instruction: 'Wake me',
      sessionId: session.id,
      source: 'github',
      filter: {
        owner: 'lucasaarch',
        repo: 'jian',
        events: ['check_suite.completed'],
      },
      enabled: true,
    },
    'owner',
  );

  await expect(services.subscriptions.remove(b.id, created.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(await services.subscriptions.list(a.id)).toHaveLength(1);
});

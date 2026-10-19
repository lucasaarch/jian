import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

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

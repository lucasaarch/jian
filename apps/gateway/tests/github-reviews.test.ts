import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { GitHubIntegrations } from '../src/integrations/github.js';
import { pullRows, searchQuery } from '../src/reviews/pulls.js';
import { githubInstallations } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const secret = 'synthetic-webhook-secret';
const head = 'a'.repeat(40);
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/**
 * A server gateway with one connected account, `octo-example`, and a GitHub that says 404 unless
 * the test answers for it.
 */
async function gateway(
  options: { mode?: 'server' | 'local'; webhook?: boolean; github?: typeof fetch } = {},
) {
  const services = await testServices();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await services.gatewayVault.put(
    'github-app-config',
    JSON.stringify({
      appId: 1,
      slug: 'jian-example',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );
  if (options.webhook !== false) await services.gatewayVault.put('github-webhook-secret', secret);
  await services.store.db.insert(githubInstallations).values({
    id: randomUUID(),
    installationId: 101,
    accountId: 1,
    login: 'octo-example',
    type: 'User',
  });
  const github =
    options.github ?? (async () => Response.json({ message: 'Not Found' }, { status: 404 }));
  const integrations = new GitHubIntegrations(
    services.store,
    services.gatewayVault,
    'https://jian.example.test',
    github as typeof fetch,
  );
  const app = createApp({
    ...services,
    token,
    logger: false,
    github: integrations,
    mode: options.mode ?? 'server',
  });
  apps.push(app);
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Review.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  return { app, services, profile };
}

const opened = (
  overrides: { action?: string; draft?: boolean; repo?: string; sha?: string } = {},
) =>
  JSON.stringify({
    action: overrides.action ?? 'opened',
    pull_request: {
      number: 7,
      draft: overrides.draft ?? false,
      head: { sha: overrides.sha ?? head },
    },
    repository: { name: overrides.repo ?? 'site', owner: { login: 'octo-example' } },
  });

const deliver = (app: FastifyInstance, body: string, sign = secret, event = 'pull_request') =>
  app.inject({
    method: 'POST',
    url: '/v1/integrations/github/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${createHmac('sha256', sign).update(body).digest('hex')}`,
    },
    payload: body,
  });

const settle = (app: FastifyInstance, settings: Record<string, unknown>) =>
  app.inject({
    method: 'PUT',
    url: '/v1/integrations/github/reviews',
    headers,
    payload: {
      instructions: 'Check the tests.',
      auto: true,
      drafts: false,
      repositories: [],
      ...settings,
    },
  });

it('keeps the pull requests and review settings to the owner', async () => {
  const { app } = await gateway();
  for (const [method, url] of [
    ['GET', '/v1/integrations/github/pulls'],
    ['GET', '/v1/integrations/github/reviews'],
    ['PUT', '/v1/integrations/github/reviews'],
    ['POST', '/v1/integrations/github/reviews/webhook'],
    ['POST', '/v1/integrations/github/pulls/octo-example/site/7/review'],
  ] as const) {
    expect((await app.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
  }
});

it('offers no reviews on a desktop app’s own gateway', async () => {
  const { app } = await gateway({ mode: 'local' });
  const response = await app.inject({
    method: 'GET',
    url: '/v1/integrations/github/reviews',
    headers,
  });
  expect(response.statusCode).toBe(404);
});

it('refuses a delivery not signed with the secret it holds', async () => {
  const { app, services, profile } = await gateway();
  await settle(app, { profileId: profile.id });

  expect((await deliver(app, opened(), 'another-secret')).statusCode).toBe(401);
  const unsigned = await app.inject({
    method: 'POST',
    url: '/v1/integrations/github/webhook',
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' },
    payload: opened(),
  });
  expect(unsigned.statusCode).toBe(401);
  expect(await services.runs.activities(profile.id)).toHaveLength(0);
});

it('refuses every delivery while no webhook is set up', async () => {
  const { app } = await gateway({ webhook: false });
  expect((await deliver(app, opened())).statusCode).toBe(404);
});

it('starts one automatic review per head commit, however often GitHub delivers it', async () => {
  const { app, services, profile } = await gateway();
  await settle(app, { profileId: profile.id });

  const first = await deliver(app, opened());
  expect(first.statusCode).toBe(202);
  expect(first.json()).toEqual({ accepted: true });
  expect((await deliver(app, opened())).json()).toEqual({ accepted: false });
  expect((await deliver(app, opened({ action: 'reopened' }))).json()).toEqual({ accepted: false });

  const runs = await services.runs.activities(profile.id);
  expect(runs).toHaveLength(1);
  const sessionId = runs[0]?.sessionId ?? '';
  const session = await services.sessions.session(profile.id, sessionId);
  expect(session.title).toBe('Review octo-example/site#7');
  const brief = JSON.stringify(await services.sessions.messages(profile.id, sessionId));
  expect(brief).toContain('https://github.com/octo-example/site/pull/7');
  expect(brief).toContain('Check the tests.');

  // A new commit is a new head to review.
  expect((await deliver(app, opened({ action: 'reopened', sha: 'b'.repeat(40) }))).json()).toEqual({
    accepted: true,
  });

  const settings = await app.inject({
    method: 'GET',
    url: '/v1/integrations/github/reviews',
    headers,
  });
  expect(settings.json().webhook).toMatchObject({
    configured: true,
    url: 'https://jian.example.test/v1/integrations/github/webhook',
  });
  expect(settings.json().webhook.receivedAt).toBeTruthy();
});

it('starts nothing the settings leave out', async () => {
  const { app, services, profile } = await gateway();

  await settle(app, { profileId: profile.id, auto: false });
  expect((await deliver(app, opened())).json()).toEqual({ accepted: false });

  await settle(app, { profileId: profile.id, repositories: ['octo-example/docs'] });
  expect((await deliver(app, opened())).json()).toEqual({ accepted: false });

  await settle(app, { profileId: profile.id });
  expect((await deliver(app, opened({ draft: true }))).json()).toEqual({ accepted: false });
  expect((await deliver(app, opened({ action: 'closed' }))).json()).toEqual({ accepted: false });
  expect((await deliver(app, opened(), secret, 'push')).json()).toEqual({ accepted: false });

  expect(await services.runs.activities(profile.id)).toHaveLength(0);

  await settle(app, { profileId: profile.id, drafts: true, repositories: ['Octo-Example/Site'] });
  expect((await deliver(app, opened({ draft: true }))).json()).toEqual({ accepted: true });
});

it('says when the App cannot see a pull request the owner asked to review', async () => {
  const { app, profile } = await gateway();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/integrations/github/pulls/octo-example/site/7/review',
    headers,
    payload: { profileId: profile.id },
  });
  expect(response.statusCode).toBe(404);
});

it('follows an App renamed on GitHub to its new settings page and bot', async () => {
  const github = async (input: string | URL) =>
    new URL(String(input)).pathname === '/app'
      ? Response.json({
          slug: 'atlas-example',
          name: 'Atlas Example',
          owner: { login: 'octo-example', type: 'User' },
          permissions: { pull_requests: 'write' },
        })
      : Response.json({ message: 'Not Found' }, { status: 404 });
  const { app, services } = await gateway({ github: github as typeof fetch });

  const status = await app.inject({
    method: 'GET',
    url: '/v1/integrations/github/reviews',
    headers,
  });
  expect(status.json().webhook.appSettingsUrl).toBe(
    'https://github.com/settings/apps/atlas-example',
  );
  // Kept, so the bot's own comments are still known as its own when GitHub is not asked.
  const stored = JSON.parse((await services.gatewayVault.read('github-app-config')) ?? '{}');
  expect(stored).toMatchObject({ slug: 'atlas-example', clientId: 'synthetic-client' });
});

it('searches open pull requests in the account, narrowed by the filter', () => {
  expect(searchQuery('user:octo-example', 'open', undefined, 'river')).toBe(
    'is:pr is:open archived:false sort:updated-desc user:octo-example',
  );
  expect(searchQuery('repo:octo-example/site', 'mine', '  fix\nlogin ', 'river')).toBe(
    'is:pr is:open archived:false sort:updated-desc repo:octo-example/site author:river fix login',
  );
  expect(searchQuery('user:octo-example', 'review', undefined, undefined)).toContain(
    'draft:false -review:approved',
  );
});

it('reads a row of GitHub’s search, and skips what is not a pull request', () => {
  const [row, ...rest] = pullRows([
    {},
    {
      number: 7,
      title: 'Add the pricing page',
      url: 'https://github.com/octo-example/site/pull/7',
      isDraft: false,
      createdAt: '2026-10-28T09:00:00Z',
      updatedAt: '2026-10-29T09:30:00Z',
      headRefName: 'pricing-page',
      headRefOid: head,
      reviewDecision: 'REVIEW_REQUIRED',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      author: { login: 'river-example', avatarUrl: 'https://avatars.example.test/river.png' },
      repository: { name: 'site', owner: { login: 'octo-example' } },
      labels: { nodes: [{ name: 'web', color: 'ededed' }] },
      reviewRequests: { nodes: [{ requestedReviewer: { slug: 'design' } }] },
      latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'sky-example' } }] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  checkRunCountsByState: [
                    { state: 'SUCCESS', count: 3 },
                    { state: 'FAILURE', count: 1 },
                    { state: 'IN_PROGRESS', count: 1 },
                  ],
                  statusContextCountsByState: [{ state: 'SUCCESS', count: 1 }],
                },
              },
            },
          },
        ],
      },
    },
  ]);
  expect(rest).toEqual([]);
  expect(row).toMatchObject({
    owner: 'octo-example',
    repo: 'site',
    number: 7,
    reviewDecision: 'review_required',
    mergeable: 'blocked',
    checks: { passing: 4, failing: 1, pending: 1 },
    reviewers: [
      { login: 'sky-example', state: 'approved' },
      { login: 'design', state: 'requested' },
    ],
    labels: [{ name: 'web', color: 'ededed' }],
  });
});

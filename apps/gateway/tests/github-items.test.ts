import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { patchDiff } from '../src/agent/diff.js';
import { createApp } from '../src/app.js';
import { GitHubIntegrations } from '../src/integrations/github.js';
import { githubInstallations } from '../src/storage/schema.js';
import { events } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const head = 'a'.repeat(40);
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

type Answer = { status?: number; body: unknown };

/**
 * A gateway with one connected account, `octo-example`, and a GitHub that answers from `routes`
 * by method and path. Anything not listed is a 404, which is what GitHub says about a repository
 * the installation was not granted.
 */
async function gateway(routes: Record<string, Answer | ((init?: RequestInit) => Answer)>) {
  const services = await testServices();
  const asked: { method: string; path: string; authorization: string | null; body?: string }[] = [];
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
  await services.store.db.insert(githubInstallations).values({
    id: randomUUID(),
    installationId: 101,
    accountId: 1,
    login: 'octo-example',
    type: 'Organization',
  });

  const github = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);

    if (url.pathname === '/app/installations/101/access_tokens') {
      return Response.json({
        token: 'synthetic-installation-token',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    const method = init?.method ?? 'GET';
    const path = `${url.pathname}${url.search}`;

    asked.push({
      method,
      path,
      authorization: new Headers(init?.headers).get('authorization'),
      ...(init?.body ? { body: String(init.body) } : {}),
    });
    const route = routes[`${method} ${path}`];
    const answer = typeof route === 'function' ? route(init) : route;

    return answer
      ? Response.json(answer.body, { status: answer.status ?? 200 })
      : Response.json({ message: 'Not Found' }, { status: 404 });
  };
  const integrations = new GitHubIntegrations(
    services.store,
    services.gatewayVault,
    'https://jian.example.test',
    github as typeof fetch,
  );
  const app = createApp({ ...services, token, logger: false, github: integrations });

  apps.push(app);
  return { app, asked, services };
}

const base = '/repos/octo-example/site';

const pull = (overrides: Record<string, unknown> = {}) => ({
  html_url: 'https://github.com/octo-example/site/pull/7',
  number: 7,
  title: 'Add the pricing page',
  state: 'open',
  draft: false,
  merged: false,
  merged_at: null,
  user: { login: 'river-example', avatar_url: 'https://avatars.example.test/river.png' },
  base: { ref: 'main', sha: 'b'.repeat(40) },
  head: { ref: 'pricing-page', sha: head },
  body: 'Adds `/pricing` with three plans.',
  created_at: '2026-10-28T09:00:00Z',
  updated_at: '2026-10-29T09:30:00Z',
  additions: 12,
  deletions: 3,
  changed_files: 1,
  mergeable: true,
  mergeable_state: 'clean',
  ...overrides,
});

const pullRoutes = (overrides: Record<string, unknown> = {}) => ({
  [`GET ${base}/pulls/7`]: { body: pull(overrides) },
  [`GET ${base}`]: {
    body: { allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true },
  },
  [`GET ${base}/pulls/7/reviews?per_page=100`]: {
    body: [
      {
        user: { login: 'sky-example' },
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-10-28T10:00:00Z',
      },
      { user: { login: 'sky-example' }, state: 'APPROVED', submitted_at: '2026-10-29T08:00:00Z' },
      { user: { login: 'lee-example' }, state: 'COMMENTED', submitted_at: '2026-10-28T11:00:00Z' },
    ],
  },
  [`GET ${base}/commits/${head}/check-runs?per_page=100`]: {
    body: {
      check_runs: [
        {
          id: 1,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/octo-example/site/runs/1',
          started_at: '2026-10-29T09:00:00Z',
          completed_at: '2026-10-29T09:04:00Z',
        },
        // A re-run of the same check: the newer one is the result.
        {
          id: 2,
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/octo-example/site/runs/2',
          started_at: '2026-10-29T09:10:00Z',
          completed_at: '2026-10-29T09:13:00Z',
        },
        {
          id: 3,
          name: 'build',
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-10-29T09:10:00Z',
        },
      ],
    },
  },
  [`GET ${base}/commits/${head}/status`]: {
    body: {
      statuses: [
        {
          context: 'deploy/preview',
          state: 'failure',
          target_url: 'https://preview.example.test/7',
          created_at: '2026-10-29T09:00:00Z',
          updated_at: '2026-10-29T09:02:00Z',
        },
      ],
    },
  },
  [`GET ${base}/pulls/7/files?per_page=100`]: {
    body: [
      {
        filename: 'app/pricing.tsx',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch:
          '@@ -1,3 +1,4 @@ export function Pricing() {\n const plans = 3;\n-return null;\n+return <Plans />;\n+// three plans\n end();\n\\ No newline at end of file',
      },
      { filename: 'public/logo.png', status: 'added', additions: 0, deletions: 0 },
    ],
  },
});

it('reads a pull request with its merge state, methods, reviews, checks and diffs', async () => {
  const { app, asked } = await gateway(pullRoutes());
  const response = await app.inject({
    url: '/v1/integrations/github/pulls/octo-example/site/7',
    headers,
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();

  expect(body).toMatchObject({
    owner: 'octo-example',
    repo: 'site',
    number: 7,
    title: 'Add the pricing page',
    state: 'open',
    draft: false,
    author: { login: 'river-example', avatarUrl: 'https://avatars.example.test/river.png' },
    base: { ref: 'main' },
    head: { ref: 'pricing-page', sha: head },
    mergeable: 'clean',
    mergeMethods: ['squash', 'rebase'],
    reviews: { approved: 1, changesRequested: 0, commented: 1 },
  });
  expect(
    body.reviews.latest.map((review: { reviewer: { login: string } }) => review.reviewer.login),
  ).toEqual(['lee-example', 'sky-example']);
  expect(body.checks.summary).toEqual({ passing: 1, failing: 1, pending: 1 });
  expect(body.checks.runs.map((run: { name: string }) => run.name)).toEqual([
    'test',
    'build',
    'deploy/preview',
  ]);
  expect(body.files[0].diff.hunks[0]).toMatchObject({
    oldStart: 1,
    newStart: 1,
    header: 'export function Pricing() {',
  });
  expect(body.files[0].diff.hunks[0].lines).toEqual([
    { kind: 'context', old: 1, new: 1, text: 'const plans = 3;' },
    { kind: 'del', old: 2, text: 'return null;' },
    { kind: 'add', new: 2, text: 'return <Plans />;' },
    { kind: 'add', new: 3, text: '// three plans' },
    { kind: 'context', old: 3, new: 4, text: 'end();' },
  ]);
  // A binary file has no patch: listed, without a diff.
  expect(body.files[1]).toEqual({
    path: 'public/logo.png',
    status: 'added',
    additions: 0,
    deletions: 0,
  });
  // Every request went with the installation's token, and none of it came back.
  expect(asked.every((item) => item.authorization === 'Bearer synthetic-installation-token')).toBe(
    true,
  );
  expect(response.body).not.toContain('synthetic-installation-token');
});

it('says unknown while GitHub is still working out whether it merges', async () => {
  const { app } = await gateway(pullRoutes({ mergeable: null, mergeable_state: 'unknown' }));
  const response = await app.inject({
    url: '/v1/integrations/github/pulls/octo-example/site/7',
    headers,
  });

  expect(response.json().mergeable).toBe('unknown');
});

it('names conflicts', async () => {
  const { app } = await gateway(pullRoutes({ mergeable: false, mergeable_state: 'dirty' }));
  const response = await app.inject({
    url: '/v1/integrations/github/pulls/octo-example/site/7',
    headers,
  });

  expect(response.json().mergeable).toBe('conflicts');
});

it('reads a merged pull request as merged', async () => {
  const { app } = await gateway(
    pullRoutes({ state: 'closed', merged: true, merged_at: '2026-10-29T10:00:00Z' }),
  );
  const response = await app.inject({
    url: '/v1/integrations/github/pulls/octo-example/site/7',
    headers,
  });

  expect(response.json()).toMatchObject({ state: 'merged', mergedAt: '2026-10-29T10:00:00.000Z' });
});

it('never asks GitHub about an account no installation is on', async () => {
  const { app, asked } = await gateway(pullRoutes());
  const response = await app.inject({
    url: '/v1/integrations/github/pulls/someone-else/private/3',
    headers,
  });

  expect(response.statusCode).toBe(404);
  expect(asked).toEqual([]);
});

it('treats a repository the installation was not granted as not found', async () => {
  const { app } = await gateway({});
  const response = await app.inject({
    url: '/v1/integrations/github/issues/octo-example/secret/4',
    headers,
  });

  expect(response.statusCode).toBe(404);
  expect(response.body).not.toContain('synthetic-installation-token');
});

it('reads an issue with its labels, assignees and latest comments, and spots a pull request', async () => {
  const comments = Array.from({ length: 35 }, (_, index) => ({
    user: { login: 'lee-example' },
    body: `Comment ${index + 1}`,
    created_at: '2026-10-29T08:00:00Z',
  }));
  const issue = {
    html_url: 'https://github.com/octo-example/site/issues/12',
    number: 12,
    title: 'Pricing page is blank on Safari',
    state: 'open',
    user: { login: 'sky-example' },
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [{ login: 'river-example' }],
    body: 'Steps to reproduce…',
    comments: 35,
    created_at: '2026-10-27T08:00:00Z',
    updated_at: '2026-10-29T08:00:00Z',
    closed_at: null,
  };
  const { app } = await gateway({
    [`GET ${base}/issues/12`]: { body: issue },
    [`GET ${base}/issues/12/comments?per_page=30&page=1`]: { body: comments.slice(0, 30) },
    [`GET ${base}/issues/12/comments?per_page=30&page=2`]: { body: comments.slice(30) },
    [`GET ${base}/issues/7`]: {
      body: { ...issue, number: 7, comments: 0, pull_request: { url: 'x' } },
    },
  });
  const body = (
    await app.inject({ url: '/v1/integrations/github/issues/octo-example/site/12', headers })
  ).json();

  expect(body).toMatchObject({
    kind: 'issue',
    state: 'open',
    labels: [{ name: 'bug', color: 'd73a4a' }],
    assignees: [{ login: 'river-example' }],
  });
  expect(body.comments).toHaveLength(30);
  expect(body.comments[0].body).toBe('Comment 6');
  expect(body.comments.at(-1).body).toBe('Comment 35');

  const asPull = await app.inject({
    url: '/v1/integrations/github/issues/octo-example/site/7',
    headers,
  });
  expect(asPull.json().kind).toBe('pull');
});

it('summarizes links for cards, keeps an unseen one plain, and reuses a recent answer', async () => {
  const { app, asked } = await gateway(pullRoutes());
  const resolve = () =>
    app.inject({
      method: 'POST',
      url: '/v1/integrations/github/links',
      headers,
      payload: {
        urls: [
          'https://github.com/octo-example/site/pull/7/files#diff-1',
          'https://github.com/someone-else/private/pull/3',
          'https://example.test/not-github',
        ],
      },
    });
  const first = await resolve();

  expect(first.statusCode).toBe(200);
  expect(first.json()).toEqual([
    {
      url: 'https://github.com/octo-example/site/pull/7/files#diff-1',
      reachable: true,
      kind: 'pull',
      owner: 'octo-example',
      repo: 'site',
      number: 7,
      title: 'Add the pricing page',
      state: 'open',
      draft: false,
      checks: { passing: 1, failing: 1, pending: 1 },
      mergeable: 'clean',
    },
    { url: 'https://github.com/someone-else/private/pull/3', reachable: false },
    { url: 'https://example.test/not-github', reachable: false },
  ]);

  const count = asked.length;
  await resolve();
  expect(asked).toHaveLength(count);
});

it('merges with the method and the head the owner saw, and records it on the agent', async () => {
  const { app, asked, services } = await gateway({
    [`PUT ${base}/pulls/7/merge`]: {
      body: { sha: 'c'.repeat(40), merged: true, message: 'Pull Request successfully merged' },
    },
  });
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/integrations/github/pulls/octo-example/site/7/merge',
    headers,
    payload: { method: 'squash', expectedHeadSha: head, profileId: profile.id },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    merged: true,
    sha: 'c'.repeat(40),
    message: 'Pull Request successfully merged',
  });
  expect(JSON.parse(asked[0]?.body ?? '{}')).toEqual({ merge_method: 'squash', sha: head });
  expect(response.body).not.toContain('synthetic-installation-token');

  const recorded = (await events(services.store, profile.id)).filter(
    (event) => event.type === 'github.pull.merged',
  );
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.data).toMatchObject({ owner: 'octo-example', number: 7, method: 'squash' });
});

it('reads a pull request it merged as merged while GitHub still answers open', async () => {
  // GitHub's reads lag its writes: the pull request below still says open after the merge.
  const { app } = await gateway({
    ...pullRoutes(),
    [`PUT ${base}/pulls/7/merge`]: {
      body: { sha: 'c'.repeat(40), merged: true, message: 'Pull Request successfully merged' },
    },
  });
  const url = 'https://github.com/octo-example/site/pull/7';
  const card = async () =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/integrations/github/links',
        headers,
        payload: { urls: [url] },
      })
    ).json()[0];

  expect((await card()).state).toBe('open');
  await app.inject({
    method: 'POST',
    url: '/v1/integrations/github/pulls/octo-example/site/7/merge',
    headers,
    payload: { method: 'squash', expectedHeadSha: head },
  });

  expect((await card()).state).toBe('merged');
  const drawer = await app.inject({
    url: '/v1/integrations/github/pulls/octo-example/site/7',
    headers,
  });
  expect(drawer.json().state).toBe('merged');
});

it('answers 409 with GitHub’s reason when the merge is refused', async () => {
  const { app } = await gateway({
    [`PUT ${base}/pulls/7/merge`]: {
      status: 409,
      body: { message: 'Head branch was modified. Review and try the merge again.' },
    },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/integrations/github/pulls/octo-example/site/7/merge',
    headers,
    payload: { method: 'merge', expectedHeadSha: head },
  });

  expect(response.statusCode).toBe(409);
  expect(response.json().error).toContain('Head branch was modified');
});

it('parses a patch whose hunk counts are left out, and holds none for an empty one', () => {
  expect(patchDiff('a.txt', '@@ -1 +1 @@\n-old\n+new')?.hunks[0]).toMatchObject({
    oldLines: 1,
    newLines: 1,
    lines: [
      { kind: 'del', old: 1, text: 'old' },
      { kind: 'add', new: 1, text: 'new' },
    ],
  });
  expect(patchDiff('a.txt', '')).toBeUndefined();
});

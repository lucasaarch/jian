import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { GitHubIntegrations } from '../src/integrations/github.js';
import { githubInstallations, projects } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };
const hour = 60 * 60_000;

/**
 * Two connected accounts and a GitHub that issues numbered installation tokens, each lasting an
 * hour from the test clock, and lists one repository per installation.
 */
async function connected({ registered = true } = {}) {
  const services = await testServices();
  let now = Date.parse('2026-10-29T12:00:00Z');
  const minted: { installation: string; body: string }[] = [];

  if (registered) {
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
  }

  const github = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);

    if (mint?.[1]) {
      minted.push({ installation: mint[1], body: String(init?.body ?? '') });
      return Response.json({
        token: `synthetic-token-${minted.length}`,
        expires_at: new Date(now + hour).toISOString(),
      });
    }
    if (url.pathname === '/installation/repositories') {
      // Each installation lists its own: the token says which one is asking.
      const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '');
      const installation = minted[Number(token?.replace('synthetic-token-', '')) - 1]?.installation;
      const [owner, id, name] =
        installation === '101' ? ['octo-example', 42, 'site'] : ['mona', 7, 'notes'];
      return Response.json({
        repositories: [
          {
            id,
            name,
            full_name: `${owner}/${name}`,
            owner: { login: owner },
            private: true,
            html_url: `https://github.com/${owner}/${name}`,
            clone_url: `https://github.com/${owner}/${name}.git`,
            default_branch: 'main',
          },
        ],
      });
    }

    return new Response('not found', { status: 404 });
  };
  const integrations = new GitHubIntegrations(
    services.store,
    services.gatewayVault,
    'https://jian.example.test',
    github as typeof fetch,
    () => now,
  );
  const organization = randomUUID();

  await services.store.db.insert(githubInstallations).values([
    {
      id: organization,
      installationId: 101,
      accountId: 1,
      login: 'octo-example',
      type: 'Organization',
    },
    { id: randomUUID(), installationId: 202, accountId: 2, login: 'mona', type: 'User' },
  ]);
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model,
  });

  return {
    services,
    integrations,
    minted,
    organization,
    profile,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it('reaches every connected account, each with its whole installation, outside a project', async () => {
  const { integrations, minted, profile } = await connected();

  expect(await integrations.mcpAccess(profile.id)).toEqual([
    { login: 'mona', token: 'synthetic-token-1' },
    { login: 'octo-example', token: 'synthetic-token-2' },
  ]);
  // No repository list in the request: the token covers what the owner granted the App.
  expect(minted).toEqual([
    { installation: '202', body: '' },
    { installation: '101', body: '' },
  ]);
});

it('reaches only the repository a project is bound to', async () => {
  const { services, integrations, minted, organization, profile } = await connected();
  const project = randomUUID();

  await services.store.db.insert(projects).values({
    id: project,
    profileId: profile.id,
    name: 'Site',
    repositoryUrl: 'https://github.com/octo-example/site.git',
    githubAccountId: organization,
    githubRepositoryId: 42,
  });

  expect(await integrations.mcpAccess(profile.id, project)).toEqual([
    expect.objectContaining({ login: 'octo-example', repository: 'octo-example/site' }),
  ]);
  expect(minted.at(-1)).toEqual({ installation: '101', body: '{"repository_ids":[42]}' });
  // Another agent's project is not this agent's to reach through.
  const other = await services.profiles.createProfile({
    name: 'Zero',
    instructions: 'Help.',
    model,
  });
  expect((await integrations.mcpAccess(other.id, project)).map((access) => access.login)).toEqual([
    'mona',
    'octo-example',
  ]);
});

it('reuses a token until shortly before it expires', async () => {
  const { integrations, minted, profile, advance } = await connected();

  await integrations.mcpAccess(profile.id);
  advance(50 * 60_000);
  await integrations.mcpAccess(profile.id);
  expect(minted).toHaveLength(2);

  advance(6 * 60_000);
  await integrations.mcpAccess(profile.id);
  expect(minted).toHaveLength(4);
});

it('reaches nothing until a GitHub App is registered', async () => {
  const { integrations, minted, profile } = await connected({ registered: false });

  expect(await integrations.mcpAccess(profile.id)).toEqual([]);
  expect(minted).toEqual([]);
});

it('lends polling the token of the connected account that owns the repository', async () => {
  const { integrations, minted } = await connected();

  expect(await integrations.tokenFor('Octo-Example')).toBe('synthetic-token-1');
  expect(minted).toEqual([{ installation: '101', body: '' }]);
  // Nobody connected owns it: the poll goes out as a stranger, and a public repo still answers.
  expect(await integrations.tokenFor('someone-else')).toBeUndefined();
});

it('lists the repositories of every connected account in one list, each with its account', async () => {
  const { integrations, organization } = await connected();

  expect(
    (await integrations.allRepositories()).map(({ fullName, accountId }) => ({
      fullName,
      organization: accountId === organization,
    })),
  ).toEqual([
    { fullName: 'mona/notes', organization: false },
    { fullName: 'octo-example/site', organization: true },
  ]);
});

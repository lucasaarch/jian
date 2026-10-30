import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { GitHubIntegrations } from '../src/integrations/github.js';
import { SecretBox } from '../src/security/crypto.js';
import { GatewayVault } from '../src/security/gateway-vault.js';
import { TestStore } from './helpers/database.js';

const panel = 'https://jian.example.test';
const returnPath = '/settings/integrations/github';
const installationId = 176_441_029;

/**
 * A registered App and a GitHub that answers the three calls a connection makes: the code for a
 * user token, the installations that user reaches, and the installation's account.
 */
async function connect(reached: number[]) {
  const store = await TestStore.create();
  const vault = new GatewayVault(
    store,
    new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
  );
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  await vault.put(
    'github-app-config',
    JSON.stringify({
      appId: 1,
      slug: 'jian-example',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );

  const github = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);

    if (url.pathname === '/login/oauth/access_token') {
      return Response.json({ access_token: 'synthetic-user-token' });
    }
    if (url.pathname === '/user/installations') {
      return Response.json({ installations: reached.map((id) => ({ id })) });
    }
    if (url.pathname === `/app/installations/${installationId}`) {
      return Response.json({ account: { id: 9, login: 'octo-example', type: 'Organization' } });
    }

    return new Response('not found', { status: 404 });
  };
  const integrations = new GitHubIntegrations(store, vault, panel, github as typeof fetch);
  const { url } = await integrations.start(panel, returnPath);
  const state = new URL(url).searchParams.get('state') ?? '';

  return {
    integrations,
    result: await integrations.finish(state, 'synthetic-code', installationId),
  };
}

it('records the account GitHub installed the App on and sends the owner back', async () => {
  const { integrations, result } = await connect([installationId]);

  expect(result.failure).toBeUndefined();
  expect(result.location).toBe(`${panel}${returnPath}?github=connected`);
  expect((await integrations.status()).accounts).toEqual([
    expect.objectContaining({ installationId, login: 'octo-example', type: 'Organization' }),
  ]);
});

it('refuses an installation the authorized account cannot reach, and saves nothing', async () => {
  const { integrations, result } = await connect([1]);

  expect(result.failure?.reason).toBe('not-owner');
  expect(result.location).toBe(`${panel}${returnPath}?github=failed&reason=not-owner`);
  expect((await integrations.status()).accounts).toEqual([]);
});

it("names a new App without the installation's address", async () => {
  const store = await TestStore.create();
  const vault = new GatewayVault(
    store,
    new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
  );
  const integrations = new GitHubIntegrations(store, vault, panel);

  const first = await integrations.registration(panel, returnPath);
  const second = await integrations.registration(panel, returnPath);

  expect(first.manifest.name).toMatch(/^Jian - [0-9a-f]{8}$/);
  expect(first.manifest.name).not.toBe(second.manifest.name);
});

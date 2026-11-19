import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { createApp } from '../src/app.js';
import { providerSecret } from '../src/providers/service.js';
import { providers } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const keys = ['sk-synthetic-first-account', 'sk-synthetic-second-account', 'sk-synthetic-third'];

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function withAccounts(count: number) {
  const services = await testServices();
  const accounts = [];
  for (const secret of keys.slice(0, count)) {
    accounts.push(
      await services.providers.createProvider({ name: 'OpenAI', kind: 'openai', secret }),
    );
  }

  return { services, accounts };
}

/** What the database says is live and active for OpenAI keys, read past the service. */
async function activeRows(services: Awaited<ReturnType<typeof testServices>>) {
  return services.store.db
    .select({ id: providers.id })
    .from(providers)
    .where(
      and(eq(providers.kind, 'openai'), isNull(providers.revokedAt), eq(providers.active, true)),
    );
}

it('keeps several accounts of one vendor, the newest active, and lists only it to runs', async () => {
  const { services, accounts } = await withAccounts(3);
  const [first, second, third] = accounts;

  expect(accounts.map((account) => account.label)).toEqual(['Account 1', 'Account 2', 'Account 3']);
  const listed = await services.providers.accounts();
  expect(listed.map((account) => [account.id, account.active])).toEqual([
    [first?.id, false],
    [second?.id, false],
    [third?.id, true],
  ]);
  expect((await services.providers.providers()).map((provider) => provider.id)).toEqual([
    third?.id,
  ]);
  // Every key is kept with its own account.
  for (const [index, account] of accounts.entries()) {
    expect(await services.gatewayVault.read(providerSecret(account.id))).toBe(keys[index]);
  }
});

it('leaves exactly one account active however switches race', async () => {
  const { services, accounts } = await withAccounts(3);

  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      services.providers.activateAccount(accounts[index % accounts.length]?.id ?? ''),
    ),
  );

  expect(await activeRows(services)).toHaveLength(1);
  // The index itself refuses a second active account, whatever a caller does.
  await expect(
    services.store.db.insert(providers).values({
      id: randomUUID(),
      name: 'OpenAI',
      kind: 'openai',
      active: true,
      createdAt: new Date(),
    }),
  ).rejects.toThrow();
});

it('runs on the account active when the run starts, whichever one it was queued with', async () => {
  const { services, accounts } = await withAccounts(1);
  const [first] = accounts;
  await services.providers.setModelDefaults({
    conversation: { providerId: first?.id, modelId: 'gpt-test' },
    channel: null,
  });
  const profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });
  const session = await services.sessions.createSession(profile.id, { title: 'Chat' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'switch',
  });
  expect(run.model?.providerId).toBe(first?.id);

  // Another account arrives, and the queued run's own account is then removed.
  const second = await services.providers.createProvider({
    name: 'OpenAI',
    kind: 'openai',
    secret: keys[1],
  });
  await services.providers.revokeProvider(first?.id ?? '');

  let used: string | undefined;
  const model = mockModel({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'Hi.' }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  await new AgentRuntime(
    services,
    (_config, _env, _fetch, key) => {
      used = key;
      return model;
    },
    { gatewayVault: services.gatewayVault },
  ).execute(profile.id, run.id);

  expect(used).toBe(keys[1]);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  // The saved default follows the vendor, so the panel still shows it chosen.
  expect((await services.providers.modelDefaults()).conversation).toMatchObject({
    providerId: second.id,
  });
});

it('carries an Anthropic choice across from a key to a Claude Code token', async () => {
  const services = await testServices();
  const key = await services.providers.createProvider({
    name: 'Anthropic',
    kind: 'anthropic',
    credential: 'key',
    secret: 'sk-ant-api-synthetic',
  });
  const plan = await services.providers.createProvider({
    name: 'Anthropic',
    kind: 'anthropic',
    credential: 'subscription',
    secret: 'sk-ant-oat-synthetic',
  });
  // Each credential numbers its own, as the panel lists them apart.
  expect([key.label, plan.label]).toEqual(['Account 1', 'Account 1']);

  const chosen = await services.providers.selectedModel(
    { providerId: key.id, modelId: 'claude-test' },
    services.store.db,
  );
  expect(chosen.config).toMatchObject({ providerId: plan.id, credential: 'subscription' });

  await services.providers.activateAccount(key.id);
  const frozen = await services.providers.activeConfig(chosen.config);
  expect(frozen).toMatchObject({ providerId: key.id, credential: 'key' });
});

it('promotes the newest account left when the active one goes, and disconnects with the last', async () => {
  const { services, accounts } = await withAccounts(3);
  const [first, second, third] = accounts;
  await services.providers.activateAccount(first?.id ?? '');

  // An inactive one leaves without moving anything.
  await services.providers.revokeProvider(third?.id ?? '');
  expect((await services.providers.accounts()).find((item) => item.active)?.id).toBe(first?.id);

  await services.providers.revokeProvider(first?.id ?? '');
  expect((await services.providers.accounts()).map((item) => [item.id, item.active])).toEqual([
    [second?.id, true],
  ]);
  expect(await services.gatewayVault.read(providerSecret(first?.id ?? ''))).toBeUndefined();

  await services.providers.revokeProvider(second?.id ?? '');
  expect(await services.providers.accounts()).toEqual([]);
  expect(
    (await services.providers.providers()).filter(
      (item) => item.kind === 'openai' && !item.apiKeyEnv,
    ),
  ).toEqual([]);
  await expect(
    services.providers.selectedModel(
      { providerId: second?.id ?? '', modelId: 'gpt-test' },
      services.store.db,
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('refreshes a ChatGPT account signing in again instead of adding a twin', async () => {
  const services = await testServices();
  const login = (account: string, email: string, version: string) => {
    const payload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: account },
        'https://api.openai.com/profile': { email },
      }),
    ).toString('base64url');
    return JSON.stringify({ access_token: `x.${payload}.${version}`, refresh_token: 'r' });
  };

  const work = await services.providers.configureCodexProvider(
    login('acct-work', 'work@example.test', '1'),
  );
  const home = await services.providers.configureCodexProvider(
    login('acct-home', 'home@example.test', '1'),
  );
  const again = await services.providers.configureCodexProvider(
    login('acct-work', 'work@example.test', '2'),
  );

  expect(work.label).toBe('work@example.test');
  expect(again.id).toBe(work.id);
  expect((await services.providers.accounts()).map((item) => [item.id, item.active])).toEqual([
    [work.id, true],
    [home.id, false],
  ]);
  expect(await services.gatewayVault.read(providerSecret(work.id))).toContain('.2"');
});

it('lists, renames, switches and removes accounts over HTTP without a key in any answer', async () => {
  const services = await testServices();
  const app = createApp({ ...services, token, logger: false });
  apps.push(app);
  const answers: string[] = [];
  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => {
    const response = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    answers.push(response.body);
    return response;
  };

  const first = (
    await call('POST', '/v1/providers', { name: 'OpenAI', kind: 'openai', secret: keys[0] })
  ).json();
  const second = (
    await call('POST', '/v1/providers', {
      name: 'OpenAI',
      kind: 'openai',
      secret: keys[1],
      label: 'Work',
    })
  ).json();
  expect(second).toMatchObject({ label: 'Work', active: true });

  const renamed = await call('PATCH', `/v1/providers/${first.id}`, { label: 'Personal' });
  expect(renamed.json()).toMatchObject({ label: 'Personal', active: false });
  const activated = await call('POST', `/v1/providers/${first.id}/activate`);
  expect(activated.json()).toMatchObject({ id: first.id, active: true });

  const listed = (await call('GET', '/v1/provider-accounts')).json();
  expect(
    listed.map((item: { label: string; active: boolean }) => [item.label, item.active]),
  ).toEqual([
    ['Personal', true],
    ['Work', false],
  ]);
  expect(
    (await call('GET', '/v1/providers')).json().map((item: { id: string }) => item.id),
  ).toEqual([first.id]);
  expect((await call('DELETE', `/v1/providers/${first.id}`)).statusCode).toBe(200);
  expect((await call('POST', `/v1/providers/${first.id}/activate`)).statusCode).toBe(404);
  expect((await call('PATCH', `/v1/providers/${randomUUID()}`, { label: 'X' })).statusCode).toBe(
    404,
  );

  for (const body of answers) {
    for (const secret of keys) expect(body).not.toContain(secret);
  }

  // Only the owner, or a paired device, manages them.
  for (const [method, url] of [
    ['GET', '/v1/provider-accounts'],
    ['PATCH', `/v1/providers/${second.id}`],
    ['POST', `/v1/providers/${second.id}/activate`],
  ] as const) {
    const refused = await app.inject({ method, url, payload: { label: 'Mine' } });
    expect(refused.statusCode).toBe(401);
  }
});

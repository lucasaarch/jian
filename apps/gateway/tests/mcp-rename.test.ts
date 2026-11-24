import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { auth } from '@ai-sdk/mcp';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpSecret, mcpValueSecret } from '../src/agent/mcp-connect.js';
import { McpOAuth } from '../src/agent/mcp-oauth.js';
import { createApp } from '../src/app.js';
import { GATEWAY_SCOPE } from '../src/security/gateway-vault.js';
import { createSafeFetch } from '../src/security/outbound.js';
import { testServices } from './helpers/services.js';

const TOKEN = 'synthetic-owner-token-of-32-characters';
const LINEAR = 'https://mcp.linear.app/mcp';
const callback = (server: string) =>
  `https://jian.example.com/v1/mcp-servers/${server}/oauth/callback`;

async function gateway() {
  const services = await testServices();
  const app = await createApp({ ...services, token: TOKEN, logger: false });
  const rename = (from: string, name: unknown) =>
    app.inject({
      method: 'POST',
      url: `/v1/mcp-servers/${from}/rename`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { name },
    });
  return { services, app, rename };
}

describe('renaming an MCP server', () => {
  it('moves its keys and sign-in to the new name, in its place in the list', async () => {
    const { services, rename } = await gateway();
    await services.mcp.replace({
      servers: [
        { name: 'docs', url: 'https://docs.example.test/mcp' },
        {
          name: 'linear_kai',
          url: LINEAR,
          auth: 'headers',
          headers: [{ name: 'Authorization', value: 'Bearer synthetic-linear-token' }],
        },
        { name: 'linear_kai_2', url: LINEAR, auth: 'oauth' },
      ],
    });
    await services.gatewayVault.put(`${mcpSecret('linear_kai_2')}:oauth`, '{"tokens":{}}');

    const first = await rename('linear_kai', 'linear_acme');
    const second = await rename('linear_kai_2', 'linear_globex');

    expect(first.statusCode).toBe(200);
    expect(second.json().map((server: { name: string }) => server.name)).toEqual([
      'docs',
      'linear_acme',
      'linear_globex',
    ]);
    const header = (server: string) => mcpValueSecret(server, 'header', 'Authorization');
    expect(await services.gatewayVault.read(header('linear_acme'))).toBe(
      'Bearer synthetic-linear-token',
    );
    expect(await services.gatewayVault.read(header('linear_kai'))).toBeUndefined();
    expect(await services.gatewayVault.read(`${mcpSecret('linear_globex')}:oauth`)).toBe(
      '{"tokens":{}}',
    );
    expect(await services.gatewayVault.read(`${mcpSecret('linear_kai_2')}:oauth`)).toBeUndefined();
  });

  it('refuses a name another server holds, one a name cannot be, and a server that is not there', async () => {
    const { services, rename } = await gateway();
    await services.mcp.replace({
      servers: [
        {
          name: 'linear_kai',
          url: LINEAR,
          auth: 'headers',
          headers: [{ name: 'Authorization', value: 'Bearer synthetic-linear-token' }],
        },
        { name: 'docs', url: 'https://docs.example.test/mcp' },
      ],
    });

    expect((await rename('linear_kai', 'docs')).statusCode).toBe(409);
    expect((await rename('linear_kai', 'Linear Acme')).statusCode).toBe(400);
    expect((await rename('linear_kai', 'x'.repeat(31))).statusCode).toBe(400);
    expect((await rename('missing', 'linear_acme')).statusCode).toBe(404);

    // Nothing moved on a refusal.
    expect((await services.mcp.list()).map((server) => server.name)).toEqual([
      'linear_kai',
      'docs',
    ]);
    expect(
      await services.gatewayVault.read(mcpValueSecret('linear_kai', 'header', 'Authorization')),
    ).toBe('Bearer synthetic-linear-token');
  });

  it('is for the owner only', async () => {
    const { services, app } = await gateway();
    await services.mcp.replace({
      servers: [{ name: 'docs', url: 'https://docs.example.test/mcp' }],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/mcp-servers/docs/rename',
      payload: { name: 'wiki' },
    });

    expect(response.statusCode).toBe(401);
    expect((await services.mcp.list()).map((server) => server.name)).toEqual(['docs']);
  });
});

/** An authorization server that registers clients for the callback they ask for. */
async function authorizationPeer() {
  const seen = { registered: [] as string[], grants: [] as string[] };
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(request.url ?? '/', origin);
    let body = '';
    for await (const chunk of request) body += chunk;
    const json = (value: unknown, status = 200) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register') {
      const { redirect_uris } = JSON.parse(body) as { redirect_uris: string[] };
      seen.registered.push(redirect_uris[0] ?? '');
      return json({ client_id: `client-${seen.registered.length}`, redirect_uris }, 201);
    }
    if (url.pathname === '/token') {
      seen.grants.push(new URLSearchParams(body).get('grant_type') ?? '');
      return json({ access_token: 'synthetic-access', token_type: 'Bearer' });
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
  cleanups.push(async () => {
    await outbound.close();
    server.close();
  });
  return { origin, seen, fetch: outbound.fetch };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('signing in again after a rename', () => {
  async function renamedAfterSignIn(tokens?: unknown) {
    const peer = await authorizationPeer();
    const services = await testServices();
    const pending = new Map<string, string>();
    const signIn = (server: string) =>
      auth(new McpOAuth(services.gatewayVault, server, callback(server), pending), {
        serverUrl: `${peer.origin}/mcp`,
        fetchFn: peer.fetch,
      });

    // Registered under the name Connect gave, then renamed: the vault entry moves as a rename does.
    expect(await signIn('linear')).toBe('REDIRECT');
    if (tokens) {
      const stored = JSON.parse((await services.gatewayVault.read('mcp:linear:oauth')) ?? '{}');
      await services.gatewayVault.put('mcp:linear:oauth', JSON.stringify({ ...stored, tokens }));
    }
    await services.store.transaction(GATEWAY_SCOPE, (tx) =>
      services.gatewayVault.move(mcpSecret('linear'), mcpSecret('linear_acme'), tx),
    );
    const result = await signIn('linear_acme');
    const authorization = new URL(pending.get('linear_acme') ?? 'about:blank');
    return { peer, result, authorization };
  }

  it('registers for the new callback, as the old one would be refused', async () => {
    const { peer, result, authorization } = await renamedAfterSignIn();

    expect(result).toBe('REDIRECT');
    expect(peer.seen.registered).toEqual([callback('linear'), callback('linear_acme')]);
    expect(authorization.searchParams.get('client_id')).toBe('client-2');
    expect(authorization.searchParams.get('redirect_uri')).toBe(callback('linear_acme'));
  });

  it('keeps refreshing with the client its tokens were issued to', async () => {
    const { peer, result } = await renamedAfterSignIn({
      access_token: 'synthetic-old',
      token_type: 'Bearer',
      refresh_token: 'synthetic-refresh',
    });

    expect(result).toBe('AUTHORIZED');
    expect(peer.seen.registered).toEqual([callback('linear')]);
    expect(peer.seen.grants).toEqual(['refresh_token']);
  });
});

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { auth } from '@ai-sdk/mcp';
import { afterEach, describe, expect, it } from 'vitest';
import { NO_CLIENT_DOCUMENT } from '../src/agent/mcp-client-document.js';
import { McpLogins } from '../src/agent/mcp-login.js';
import { McpOAuth } from '../src/agent/mcp-oauth.js';
import { probeMcpServer } from '../src/agent/mcp-probe.js';
import { createApp } from '../src/app.js';
import { createSafeFetch } from '../src/security/outbound.js';
import { testServices } from './helpers/services.js';

const PUBLIC = 'https://jian.example.com';
const DOCUMENT = `${PUBLIC}/v1/mcp-servers/voice/oauth/client`;
const CALLBACK = `${PUBLIC}/v1/mcp-servers/voice/oauth/callback`;

/**
 * A synthetic MCP server that is its own authorization server, offering registration, a client
 * id metadata document, both or neither, and recording what the gateway sent it.
 */
async function authorizationPeer(offers: { registration: boolean; document: boolean }) {
  const seen = { registered: 0, metadataReads: 0, tokenClientIds: [] as string[] };
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(request.url ?? '/', origin);
    const json = (body: unknown, status = 200) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      seen.metadataReads += 1;
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(offers.registration ? { registration_endpoint: `${origin}/register` } : {}),
        ...(offers.document ? { client_id_metadata_document_supported: true } : {}),
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register') {
      seen.registered += 1;
      return json({ client_id: 'registered-client', redirect_uris: [CALLBACK] }, 201);
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of request) body += chunk;
      seen.tokenClientIds.push(new URLSearchParams(body).get('client_id') ?? '');
      return json({ access_token: 'synthetic-access', token_type: 'Bearer' });
    }
    if (url.pathname === '/mcp') {
      response
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end();
      return;
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

async function signIn(
  peer: Awaited<ReturnType<typeof authorizationPeer>>,
  options: { documentUrl?: string | undefined; clientId?: string } = { documentUrl: DOCUMENT },
) {
  const services = await testServices();
  const pending = new Map<string, string>();
  const provider = new McpOAuth(
    services.gatewayVault,
    'voice',
    CALLBACK,
    pending,
    options.clientId ? { clientId: options.clientId } : undefined,
    { document: { url: options.documentUrl, fetch: peer.fetch } },
  );
  const result = await auth(provider, { serverUrl: `${peer.origin}/mcp`, fetchFn: peer.fetch });
  const authorization = new URL(pending.get('voice') ?? 'about:blank');

  return { services, provider, pending, result, authorization };
}

describe('the client an MCP sign-in is, by what the authorization server offers', () => {
  it('is its metadata document where the server takes one and registers nobody', async () => {
    const peer = await authorizationPeer({ registration: false, document: true });
    const { provider, result, authorization } = await signIn(peer);

    expect(result).toBe('REDIRECT');
    expect(peer.seen.registered).toBe(0);
    expect(authorization.searchParams.get('client_id')).toBe(DOCUMENT);
    expect(authorization.searchParams.get('redirect_uri')).toBe(CALLBACK);

    // The owner comes back: the code is exchanged as the same public client, with no secret.
    const finished = await auth(provider, {
      serverUrl: `${peer.origin}/mcp`,
      authorizationCode: 'synthetic-code',
      callbackState: authorization.searchParams.get('state') ?? '',
      fetchFn: peer.fetch,
    });
    expect(finished).toBe('AUTHORIZED');
    expect(peer.seen.tokenClientIds).toEqual([DOCUMENT]);
  });

  it('registers where the server offers registration too', async () => {
    const peer = await authorizationPeer({ registration: true, document: true });
    const { result, authorization } = await signIn(peer);

    expect(result).toBe('REDIRECT');
    expect(peer.seen.registered).toBe(1);
    expect(authorization.searchParams.get('client_id')).toBe('registered-client');
  });

  it('keeps a pre-registered client the owner typed, without reading for a choice', async () => {
    const peer = await authorizationPeer({ registration: false, document: true });
    const { result, authorization } = await signIn(peer, {
      documentUrl: DOCUMENT,
      clientId: 'typed-client',
    });

    expect(result).toBe('REDIRECT');
    expect(authorization.searchParams.get('client_id')).toBe('typed-client');
    // Only the SDK's own discovery read the metadata.
    expect(peer.seen.metadataReads).toBe(1);
  });

  it('refuses, saying what to set, on a gateway with no HTTPS address', async () => {
    const peer = await authorizationPeer({ registration: false, document: true });

    await expect(signIn(peer, { documentUrl: undefined })).rejects.toThrow(NO_CLIENT_DOCUMENT);
    expect(peer.seen.registered).toBe(0);
  });

  it('tells the owner why in the check, within what a status holds', async () => {
    const peer = await authorizationPeer({ registration: false, document: true });
    const services = await testServices();
    const status = await probeMcpServer(
      {
        name: 'voice',
        transport: 'http',
        url: `${peer.origin}/mcp`,
        auth: 'oauth',
        headers: [],
        args: [],
        env: [],
        disabledTools: [],
      },
      services.gatewayVault,
      peer.fetch,
      (server) =>
        new McpOAuth(services.gatewayVault, server, CALLBACK, new Map(), undefined, {
          document: { url: undefined, fetch: peer.fetch },
        }),
    );

    expect(status.reachable).toBe(false);
    expect(status.error).toBe(NO_CLIENT_DOCUMENT);
    expect(NO_CLIENT_DOCUMENT.length).toBeLessThanOrEqual(300);
  });
});

describe('the client metadata document', () => {
  const app = async (publicUrl: string) => {
    const services = await testServices();
    const mcpLogins = new McpLogins(services.gatewayVault, publicUrl);
    return createApp({
      ...services,
      token: 'synthetic-owner-token-of-32-characters',
      logger: false,
      mcpLogins,
    });
  };

  it('is public, and names exactly this gateway and the one callback of its server', async () => {
    const response = await (await app(PUBLIC)).inject({
      method: 'GET',
      url: '/v1/mcp-servers/voice/oauth/client',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.json()).toEqual({
      client_id: DOCUMENT,
      client_name: 'Jian',
      client_uri: 'https://usejian.app',
      logo_uri: 'https://usejian.app/apple-icon.png',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('writes nothing a caller sends that is not a server name', async () => {
    const gateway = await app(PUBLIC);

    for (const name of ['Voice', 'a%22b', 'x'.repeat(31), '..%2Fevil']) {
      const response = await gateway.inject({
        method: 'GET',
        url: `/v1/mcp-servers/${name}/oauth/client?redirect_uri=https://attacker.example`,
      });
      expect(response.statusCode).not.toBe(200);
    }

    const extra = await gateway.inject({
      method: 'GET',
      url: '/v1/mcp-servers/voice/oauth/client?redirect_uri=https://attacker.example',
    });
    expect(extra.body).not.toContain('attacker');
  });

  it('does not exist where nothing outside could fetch it over HTTPS', async () => {
    const response = await (await app('http://127.0.0.1:4310')).inject({
      method: 'GET',
      url: '/v1/mcp-servers/voice/oauth/client',
    });

    expect(response.statusCode).toBe(404);
  });
});

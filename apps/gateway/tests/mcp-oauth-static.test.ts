import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { auth } from '@ai-sdk/mcp';
import { describe, expect, it } from 'vitest';
import { mcpOauthClientSecretKey } from '../src/agent/mcp-connect.js';
import { McpOAuth } from '../src/agent/mcp-oauth.js';
import { clarifyOauthError } from '../src/agent/mcp-probe.js';
import { createSafeFetch } from '../src/security/outbound.js';
import { testServices } from './helpers/services.js';

/**
 * Synthetic MCP resource + authorization server with no `registration_endpoint` — the same
 * shape as GitHub Copilot MCP. Static client credentials must skip dynamic registration.
 */
function nonDcrOauthPeer() {
  const state = {
    authorizeHits: 0,
    registerHits: 0,
    clientIdSeen: '' as string,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          resource: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
          authorization_servers: [`http://127.0.0.1:${(server.address() as AddressInfo).port}`],
        }),
      );

      return;
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          // Intentionally no registration_endpoint — DCR is unavailable.
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
        }),
      );

      return;
    }

    if (url.pathname === '/register') {
      state.registerHits += 1;
      response.writeHead(404).end('no dynamic registration');

      return;
    }

    if (url.pathname === '/authorize') {
      state.authorizeHits += 1;
      state.clientIdSeen = url.searchParams.get('client_id') ?? '';
      response.writeHead(302, { Location: url.searchParams.get('redirect_uri') ?? '/' }).end();

      return;
    }

    if (url.pathname === '/mcp') {
      response
        .writeHead(401, {
          'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/oauth-protected-resource"`,
        })
        .end();

      return;
    }

    response.writeHead(404).end();
  });

  return { server, state };
}

describe('MCP OAuth without dynamic client registration', () => {
  it('clarifies the SDK refusal into the action the owner must take', () => {
    expect(
      clarifyOauthError('Incompatible auth server: does not support dynamic client registration'),
    ).toMatch(/pre-registered|OAuth App|client id/i);
  });

  it('fails DCR when neither a stored nor a static client is available', async () => {
    const { server } = nonDcrOauthPeer();

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
    const services = await testServices();
    const pending = new Map<string, string>();

    const profile = await services.profiles.createProfile({
      name: 'OAuth',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });

    const provider = new McpOAuth(
      services.vault,
      profile.id,
      'github',
      `${origin}/callback`,
      pending,
    );

    try {
      await expect(
        auth(provider, { serverUrl: `${origin}/mcp`, fetchFn: outbound.fetch }),
      ).rejects.toThrow(/does not support dynamic client registration/i);
    } finally {
      await outbound.close();
      server.close();
    }
  });

  it('uses a pre-registered client id and secret against an AS without DCR', async () => {
    const { server, state } = nonDcrOauthPeer();

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
    const services = await testServices();
    const pending = new Map<string, string>();

    const profile = await services.profiles.createProfile({
      name: 'OAuth',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      mcpServers: [
        {
          name: 'github',
          url: `${origin}/mcp`,
          auth: 'oauth',
          oauthClientId: 'static-github-client',
          oauthClientSecret: { value: 'synthetic-client-secret' },
        },
      ],
    });

    expect(JSON.stringify(profile.mcpServers)).not.toContain('synthetic-client-secret');
    expect(await services.vault.read(profile.id, mcpOauthClientSecretKey('github'))).toBe(
      'synthetic-client-secret',
    );
    expect(profile.mcpServers[0]?.oauthClientId).toBe('static-github-client');
    expect(profile.mcpServers[0]?.oauthClientSecret).toEqual({});

    const provider = new McpOAuth(
      services.vault,
      profile.id,
      'github',
      `${origin}/callback`,
      pending,
      { clientId: 'static-github-client' },
    );

    try {
      const result = await auth(provider, {
        serverUrl: `${origin}/mcp`,
        fetchFn: outbound.fetch,
      });

      expect(result).toBe('REDIRECT');
      expect(state.registerHits).toBe(0);
      expect(state.authorizeHits).toBe(0);

      const authorizationUrl = pending.get(`${profile.id}:github`);

      expect(authorizationUrl).toBeTruthy();
      expect(authorizationUrl).toContain('client_id=static-github-client');
      expect(authorizationUrl).toContain('code_challenge');
    } finally {
      await outbound.close();
      server.close();
    }
  });
});

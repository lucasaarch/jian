import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSafeFetch } from '../src/security/outbound.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-mcp-check-admin-token-32-chars';
const servers: ReturnType<typeof createServer>[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** An MCP server on this machine, answering only what a connection and a tool list need. */
async function mcpServer() {
  const server = createServer(async (req, res) => {
    let body = '';

    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body || '{}');

    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }

    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'docs', version: '1' },
          }
        : {
            tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }],
          };

    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);

  return (server.address() as AddressInfo).port;
}

/**
 * The check of a server whose name resolves inside the network, as a proxy alias does, through
 * a gateway given `fetcher` — or through a route given none, the way the bug had it.
 */
async function check(options: { allow?: boolean; resolvesTo: string; configured?: boolean }) {
  const port = await mcpServer();
  const origin = `http://docs.internal:${port}`;
  const outbound = createSafeFetch({
    allowPrivateOrigins: options.allow ? [origin] : [],
    lookup: async () => [options.resolvesTo],
  });

  clients.push(outbound);

  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Owner',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    mcpServers: [{ name: 'docs', transport: 'http', url: `${origin}/mcp` }],
  });
  const app = createApp({
    ...services,
    token,
    logger: false,
    ...(options.configured === false ? {} : { fetcher: outbound.fetch }),
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/mcp-servers/docs/check`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);

    return response.json() as { reachable: boolean; tools?: unknown[]; error?: string };
  } finally {
    await app.close();
  }
}

describe('checking an MCP server behind a private address', () => {
  it('connects when the operator allowed its origin', async () => {
    const status = await check({ allow: true, resolvesTo: '127.0.0.1' });

    expect(status).toMatchObject({ reachable: true, tools: [{ name: 'search' }] });
  });

  it('stays blocked when the origin is not allowed', async () => {
    const status = await check({ allow: false, resolvesTo: '127.0.0.1' });

    expect(status.reachable).toBe(false);
    expect(status.error).toMatch(/not permitted|HTTPS is required/);
  });

  it('never reaches a cloud metadata address, allowed origin or not', async () => {
    for (const allow of [true, false]) {
      const status = await check({ allow, resolvesTo: '169.254.169.254' });

      expect(status.reachable).toBe(false);
      expect(status.error).toMatch(/not permitted|HTTPS is required/);
    }
  });

  it('uses the gateway’s client rather than a bare one, which would refuse the allowed origin', async () => {
    const status = await check({ allow: true, resolvesTo: '127.0.0.1', configured: false });

    // A route left without the configured client knows nothing of the allowance.
    expect(status.reachable).toBe(false);
  });
});

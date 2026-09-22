import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { probeMcpServer } from '../src/agent/mcp-probe.js';
import { createSafeFetch } from '../src/security/outbound.js';
import { testServices } from './helpers/services.js';

/** Answers the handshake and lists two tools, or refuses everything with the given status. */
function mcpServer(refuseWith?: number) {
  return createServer(async (request, response) => {
    if (refuseWith) {
      response.writeHead(refuseWith).end();

      return;
    }

    let body = '';

    for await (const chunk of request) {
      body += chunk;
    }

    // The transport also opens a stream and may retry after close; anything unparseable is
    // simply acknowledged rather than crashing the test process.
    let message: { id?: unknown; method?: string };

    try {
      message = JSON.parse(body);
    } catch {
      response.writeHead(202).end();

      return;
    }

    if (message.id === undefined) {
      response.writeHead(202).end();

      return;
    }

    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'test', version: '1' },
          }
        : {
            tools: [
              { name: 'search', description: 'Search docs', inputSchema: { type: 'object' } },
              { name: 'create', description: 'Create a doc', inputSchema: { type: 'object' } },
            ],
          };

    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
}

async function check(refuseWith?: number) {
  const server = mcpServer(refuseWith);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
  const services = await testServices();

  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    mcpServers: [{ name: 'docs', url: `${origin}/mcp` }],
  });

  try {
    return await probeMcpServer(profile, 'docs', services.vault, outbound.fetch);
  } finally {
    await outbound.close();
    server.close();
  }
}

describe('checking an MCP server from the panel', () => {
  it('reports every tool the server offers, with no list to configure', async () => {
    const status = await check();

    expect(status.reachable).toBe(true);
    expect(status.tools.map((tool) => tool.name).sort()).toEqual(['create', 'search']);
    expect(status.tools[0]?.description).toBeTruthy();
  });

  it('answers with the refusal instead of failing, so the owner can act on it', async () => {
    const status = await check(401);

    expect(status.reachable).toBe(false);
    expect(status.tools).toEqual([]);
    expect(status.error).toBeTruthy();
  });

  it('says which variable is missing before trying the network', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      mcpServers: [
        {
          name: 'docs',
          url: 'https://example.com/mcp',
          auth: 'headers',
          headers: [{ name: 'Authorization', fromEnv: 'JIAN_MCP_ABSENT' }],
        },
      ],
    });

    const status = await probeMcpServer(profile, 'docs', services.vault);

    expect(status.reachable).toBe(false);
    expect(status.error).toContain('JIAN_MCP_ABSENT');
  });
});

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MCPClient } from '@ai-sdk/mcp';
import type { Run } from '@jian/contracts';
import type { ToolSet } from 'ai';
import { afterEach, expect, it } from 'vitest';
import { connectMcpTools } from '../src/agent/mcp.js';
import { createSafeFetch } from '../src/security/outbound.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A server offering two tools, answering only what the connection needs. */
async function twoTools() {
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
            serverInfo: { name: 'test', version: '1' },
          }
        : {
            tools: ['search', 'delete_everything'].map((name) => ({
              name,
              description: name,
              inputSchema: { type: 'object', properties: {} },
            })),
          };

    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it('never offers the agent a tool the owner switched off, not even to search for', async () => {
  const origin = await twoTools();
  const tools: ToolSet = {};
  const clients: MCPClient[] = [];
  const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
  const run = {
    profileId: 'p',
    profile: {
      mcpServers: [
        {
          name: 'docs',
          transport: 'http',
          url: `${origin}/mcp`,
          auth: 'none',
          headers: [],
          args: [],
          env: [],
          disabledTools: ['delete_everything'],
        },
      ],
    },
  } as unknown as Run;

  try {
    await connectMcpTools(run, tools, {
      vault: undefined,
      secrets: new Set(),
      clients,
      fetcher: outbound.fetch,
      signal: AbortSignal.timeout(5000),
    });

    const names = Object.keys(tools);

    expect(names.some((name) => name.includes('search'))).toBe(true);
    expect(names.some((name) => name.includes('delete_everything'))).toBe(false);

    const search = tools.search_mcp_tools?.execute as
      | ((input: { query: string }, options: { toolCallId: string; messages: [] }) => unknown)
      | undefined;
    const found = await search?.({ query: 'delete' }, { toolCallId: 't', messages: [] });

    expect(JSON.stringify(found)).not.toContain('delete_everything');
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await outbound.close();
  }
});

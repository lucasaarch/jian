import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import { afterEach, expect, it } from 'vitest';
import { githubMcpServer } from '../src/agent/github-mcp.js';
import { connectMcpTools } from '../src/agent/mcp.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** GitHub's server as far as `issue_write` goes, keeping the arguments each call carried. */
async function githubStandIn(calls: unknown[]) {
  const server = createServer(async (req, res) => {
    let body = '';

    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body || '{}');

    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (message.method === 'tools/call') calls.push(message.params.arguments);

    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'github', version: '1' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'issue_write',
                  description: 'Create a new or update an existing issue.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      method: { type: 'string', enum: ['create', 'update'] },
                      owner: { type: 'string' },
                      repo: { type: 'string' },
                      title: { type: 'string' },
                      parent_issue_number: { type: 'number', minimum: 1 },
                      parent_owner: { type: 'string' },
                      parent_repo: { type: 'string' },
                    },
                    required: ['method', 'owner', 'repo'],
                  },
                },
              ],
            }
          : { content: [{ type: 'text', text: '{"number":7}' }] };

    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it('creates an issue without a parent the agent filled in by habit', async () => {
  const calls: unknown[] = [];
  const origin = await githubStandIn(calls);
  const tools: ToolSet = {};
  const clients: MCPClient[] = [];
  // GitHub's address, answered here.
  const fetcher: typeof fetch = (input, init) =>
    fetch(
      String(input instanceof Request ? input.url : input).replace(/^https:\/\/[^/]+/, origin),
      init,
    );

  try {
    await connectMcpTools([githubMcpServer('github')], tools, {
      vault: { read: async () => 'test-value' },
      secrets: new Set(),
      clients,
      fetcher,
      signal: AbortSignal.timeout(5000),
    });

    const name = Object.keys(tools).find((key) => key.includes('issue_write'));
    const issueWrite = name ? tools[name] : undefined;
    const schema = (issueWrite?.inputSchema as { jsonSchema?: { properties?: object } })
      ?.jsonSchema;

    expect(Object.keys(schema?.properties ?? {})).toEqual(['method', 'owner', 'repo', 'title']);

    const execute = issueWrite?.execute as
      | ((input: object, options: { toolCallId: string; messages: [] }) => Promise<unknown>)
      | undefined;
    await execute?.(
      {
        method: 'create',
        owner: 'acme',
        repo: 'widgets',
        title: 'Widgets jam',
        parent_issue_number: 1,
        parent_owner: '',
        parent_repo: '',
      },
      { toolCallId: 'call-1', messages: [] },
    );

    expect(calls).toEqual([
      { method: 'create', owner: 'acme', repo: 'widgets', title: 'Widgets jam' },
    ]);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSafeFetch } from '../src/security/outbound.js';
import { gatewaySecrets } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-mcp-draft-admin-token-32-chars';
const key = 'synthetic-mcp-header-value';
const servers: ReturnType<typeof createServer>[] = [];
const clients: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

/** An MCP server that answers only a caller carrying `X-Key: <key>`. */
async function guardedServer() {
  const server = createServer(async (req, res) => {
    let body = '';

    for await (const chunk of req) body += chunk;

    if (req.headers['x-key'] !== key) {
      res.writeHead(401).end('unauthorized');
      return;
    }

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
        : { tools: [{ name: 'search', inputSchema: { type: 'object' } }] };

    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function gateway() {
  const origin = await guardedServer();
  const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });

  clients.push(outbound);

  const services = await testServices();
  const app = createApp({ ...services, token, logger: false, fetcher: outbound.fetch });
  const check = async (server: Record<string, unknown>) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mcp-servers/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { server },
    });

    expect(response.statusCode).toBe(200);

    return response.json() as { reachable: boolean; error?: string };
  };
  const secrets = async () =>
    (await services.store.db.select({ name: gatewaySecrets.name }).from(gatewaySecrets)).length;

  return { url: `${origin}/mcp`, services, app, check, secrets };
}

describe('testing an MCP server before it is saved', () => {
  it('uses the value typed in the form and stores nothing', async () => {
    const { url, app, check, secrets } = await gateway();

    try {
      const status = await check({
        name: 'docs',
        url,
        auth: 'headers',
        headers: [{ name: 'X-Key', value: key }],
      });

      expect(status.reachable).toBe(true);
      expect(await secrets()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('falls back to the saved value the form left blank, as saving would keep it', async () => {
    const { url, services, app, check } = await gateway();

    try {
      await services.mcp.replace({
        servers: [{ name: 'docs', url, auth: 'headers', headers: [{ name: 'X-Key', value: key }] }],
      });

      expect(
        (await check({ name: 'docs', url, auth: 'headers', headers: [{ name: 'X-Key' }] }))
          .reachable,
      ).toBe(true);
      // Another name has nothing stored under it, so the blank value stays blank.
      expect(
        await check({ name: 'other', url, auth: 'headers', headers: [{ name: 'X-Key' }] }),
      ).toMatchObject({ reachable: false, error: 'X-Key has no value configured' });
    } finally {
      await app.close();
    }
  });

  it('answers an unsaved OAuth server with the sign-in it needs, starting none', async () => {
    const { url, app, check, secrets } = await gateway();

    try {
      const status = await check({ name: 'docs', url, auth: 'oauth' });

      expect(status).toMatchObject({ reachable: false, error: expect.stringMatching(/sign-in/) });
      expect(status).not.toHaveProperty('authorizationUrl');
      expect(await secrets()).toBe(0);
    } finally {
      await app.close();
    }
  });
});

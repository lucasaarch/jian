import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { mcpValueSecret } from '../src/agent/mcp-connect.js';
import { accountOf, accountServerName } from '../src/agent/mcp-identity.js';
import { createSafeFetch } from '../src/security/outbound.js';
import { testServices } from './helpers/services.js';

const LINEAR = 'https://mcp.linear.app/mcp';

/** An MCP server with a "who am I" tool answering `answer`, counting how often it is asked. */
async function serving(answer: unknown, tools = ['get_me', 'list_issues']) {
  const asked = { who: 0, authorization: [] as string[] };
  const server = createServer(async (request, response) => {
    asked.authorization.push(String(request.headers.authorization ?? ''));
    let body = '';
    for await (const chunk of request) body += chunk;
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
    if (message.method === 'tools/call') asked.who++;
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'test', version: '1' },
          }
        : message.method === 'tools/list'
          ? {
              tools: tools.map((name) => ({
                name,
                description: name,
                inputSchema: { type: 'object' },
              })),
            }
          : { content: [{ type: 'text', text: JSON.stringify(answer) }] };
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
  // The catalog's address, answered here: the gateway knows the server as Linear's.
  const fetcher: typeof globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    return outbound.fetch(
      url.startsWith(LINEAR) ? url.replace(LINEAR, `${origin}/mcp`) : url,
      init,
    );
  };
  closers.push(async () => {
    await outbound.close();
    server.close();
  });
  return { asked, fetcher, origin };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

it('names an account by the login, the email before the @, or the name its server gives', () => {
  expect(accountOf({ content: [{ type: 'text', text: '{"login":"octo-cat"}' }] })).toBe('octo-cat');
  expect(
    accountOf({ structuredContent: { account_id: 'a1', email: 'kai@example.test', name: 'Kai' } }),
  ).toBe('kai');
  // The caller's own name, not the organisation's nested under it.
  expect(accountOf({ structuredContent: { user: { name: 'Kai Doe' }, name: 'Acme' } })).toBe(
    'Acme',
  );
  expect(accountOf({ structuredContent: { display_name: 'Acme Studio' } })).toBe('Acme Studio');
  expect(
    accountOf({ content: [{ type: 'text', text: 'Signed in. Nothing more.' }] }),
  ).toBeUndefined();

  expect(accountServerName('stripe', 'Acme Studio')).toBe('stripe_acme_studio');
  expect(accountServerName('atlassian', 'Zoë Kraus-Lindqvist von Habsburg')).toBe(
    'atlassian_zoe_kraus_lindqvist',
  );
  expect(accountServerName('linear', '---')).toBeUndefined();
});

it('renames an app server after its account on check, and moves its secrets with it', async () => {
  const { asked, fetcher } = await serving({ login: 'octo-cat' });
  const services = await testServices();
  await services.mcp.replace({
    servers: [
      {
        name: 'linear',
        url: LINEAR,
        auth: 'headers',
        headers: [{ name: 'Authorization', value: 'Bearer synthetic-linear-token' }],
      },
    ],
  });

  const status = await services.mcp.check('linear', fetcher);

  expect(status.reachable).toBe(true);
  expect(status.name).toBe('linear_octo_cat');
  expect((await services.mcp.list()).map((server) => server.name)).toEqual(['linear_octo_cat']);
  expect(
    await services.gatewayVault.read(mcpValueSecret('linear_octo_cat', 'header', 'Authorization')),
  ).toBe('Bearer synthetic-linear-token');
  expect(
    await services.gatewayVault.read(mcpValueSecret('linear', 'header', 'Authorization')),
  ).toBeUndefined();

  // Named, it is not asked again, and it still signs in with what moved.
  asked.authorization.length = 0;
  await services.mcp.check('linear_octo_cat', fetcher);
  expect(asked.who).toBe(1);
  expect(asked.authorization).toContain('Bearer synthetic-linear-token');
});

it('takes the next free name when another account already holds it', async () => {
  const { fetcher } = await serving({ login: 'octo' });
  const services = await testServices();
  await services.mcp.replace({
    servers: [
      { name: 'linear_octo', url: 'https://tickets.example.test/mcp' },
      { name: 'linear_2', url: LINEAR },
    ],
  });

  const status = await services.mcp.check('linear_2', fetcher);

  expect(status.name).toBe('linear_octo_2');
});

it('leaves a server added by hand, or one that cannot say who it is, under its name', async () => {
  const { origin } = await serving({ login: 'octo' });
  const services = await testServices();
  const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
  closers.push(() => outbound.close());
  await services.mcp.replace({ servers: [{ name: 'docs', url: `${origin}/mcp` }] });

  expect((await services.mcp.check('docs', outbound.fetch)).name).toBe('docs');

  const silent = await serving({ ok: true }, ['list_issues']);
  await services.mcp.replace({ servers: [{ name: 'linear', url: LINEAR }] });
  expect((await services.mcp.check('linear', silent.fetcher)).name).toBe('linear');
  expect(silent.asked.who).toBe(0);
});

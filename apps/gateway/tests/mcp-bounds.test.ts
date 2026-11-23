import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { mcpSchema } from '@jian/contracts';
import type { ToolSet } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { connectMcpTools } from '../src/agent/mcp.js';
import { boundedMcpFetch, MCP_LIMITS } from '../src/agent/mcp-fetch.js';
import { listAllTools, MCP_LIST_LIMITS } from '../src/agent/mcp-list.js';
import { createSafeFetch } from '../src/security/outbound.js';

type ToolsList = (id: unknown, params: { cursor?: string }, response: ServerResponse) => void;

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const answer = (response: ServerResponse, id: unknown, result: unknown) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
};

/** An MCP server that connects normally and answers `tools/list` however the test says. */
async function serverListing(list: ToolsList) {
  const server = createServer((request: IncomingMessage, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const message = JSON.parse(body);
      if (!('id' in message)) response.writeHead(202).end();
      else if (message.method === 'initialize') {
        answer(response, message.id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1.0.0' },
        });
      } else if (message.method === 'tools/list') {
        list(message.id, message.params ?? {}, response);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function connect(
  config: Record<string, unknown>,
  signal: AbortSignal = new AbortController().signal,
) {
  const outbound = createSafeFetch({ allowLoopback: true });
  const clients: MCPClient[] = [];
  closers.push(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await outbound.close();
  });
  const server = mcpSchema.parse({ name: 'fixture', ...config });

  return {
    clients,
    opened: connectMcpTools([server], {} as ToolSet, {
      vault: { read: async () => undefined },
      secrets: new Set(),
      clients,
      fetcher: outbound.fetch,
      signal,
    }),
  };
}

const tool = (name: string) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
});

/** Writes until the client goes away, honouring backpressure. */
function endless(response: ServerResponse, chunk: Buffer) {
  const write = () => {
    while (!response.destroyed) {
      if (!response.write(chunk)) {
        response.once('drain', write);
        return;
      }
    }
  };
  write();
}

it('reports a server whose tool list never ends as unavailable', async () => {
  const url = await serverListing((_id, _params, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    endless(response, Buffer.alloc(1024 * 1024, 0x20));
  });

  const { opened, clients } = connect({ transport: 'http', url });
  const { unavailable, catalog } = await opened;

  expect(catalog).toEqual([]);
  expect(clients).toEqual([]);
  expect(unavailable[0]?.reason).toContain('MCP response too large');
});

it('answers the request when one event of a stream never ends', async () => {
  const url = await serverListing((_id, _params, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ');
    endless(response, Buffer.alloc(1024 * 1024, 0x78));
  });

  const { opened } = connect({ transport: 'http', url });
  const { unavailable } = await opened;

  expect(unavailable[0]?.reason).toContain('MCP response too large');
});

it('stops at a repeated cursor instead of following it for ever', async () => {
  let pages = 0;
  const url = await serverListing((id, _params, response) => {
    pages += 1;
    answer(response, id, { tools: [tool(`tool_${pages}`)], nextCursor: 'same' });
  });

  const { opened } = connect({ transport: 'http', url });
  const { unavailable } = await opened;

  expect(pages).toBe(2);
  expect(unavailable[0]?.reason).toContain('repeats a page');
});

it('stops at the page limit when every cursor is new', async () => {
  let pages = 0;
  const url = await serverListing((id, _params, response) => {
    pages += 1;
    answer(response, id, { tools: [tool(`tool_${pages}`)], nextCursor: `page-${pages}` });
  });

  const { opened } = connect({ transport: 'http', url });
  const { unavailable } = await opened;

  expect(pages).toBe(MCP_LIST_LIMITS.pages);
  expect(unavailable[0]?.reason).toContain('pages of tools');
});

it('takes every page, and an empty cursor as the end of the list', async () => {
  const url = await serverListing((id, params, response) => {
    if (params.cursor === 'second') answer(response, id, { tools: [tool('b')], nextCursor: '' });
    else answer(response, id, { tools: [tool('a')], nextCursor: 'second' });
  });

  const { opened } = connect({ transport: 'http', url });
  const { unavailable, catalog } = await opened;

  expect(unavailable).toEqual([]);
  expect(catalog.map((entry) => entry.tool)).toEqual(['a', 'b']);
});

it('gives up on a stuck tool list at its deadline', async () => {
  const url = await serverListing(() => {});
  const outbound = createSafeFetch({ allowLoopback: true });
  const client = await createMCPClient({
    transport: { type: 'http', url, fetch: boundedMcpFetch(outbound.fetch) },
  });
  closers.push(async () => {
    await client.close();
    await outbound.close();
  });

  await expect(listAllTools(client, undefined, { ...MCP_LIST_LIMITS, ms: 150 })).rejects.toThrow(
    'did not list its tools within',
  );
});

it('ends a turn cancelled during a stuck tool list', async () => {
  const url = await serverListing(() => {});
  const controller = new AbortController();
  const { opened } = connect({ transport: 'http', url }, controller.signal);

  setTimeout(() => controller.abort(), 150);

  const ended = await Promise.race([
    opened.then(
      () => 'finished',
      () => 'cancelled',
    ),
    new Promise((done) => setTimeout(() => done('still waiting'), 5_000)),
  ]);

  expect(ended).toBe('cancelled');
});

/** A command that speaks MCP, writes its pid, then runs `onList` on `tools/list`. */
function stdioServer(capabilities: string, onList: string) {
  const dir = mkdtempSync(join(tmpdir(), 'jian-mcp-bounds-'));
  const pidFile = join(dir, 'pid');
  const script = join(dir, 'server.mjs');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
let held = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  held += data;
  for (let end = held.indexOf('\\n'); end >= 0; end = held.indexOf('\\n')) {
    const message = JSON.parse(held.slice(0, end));
    held = held.slice(end + 1);
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2025-06-18', capabilities: ${capabilities},
        serverInfo: { name: 'fixture', version: '1.0.0' } } }) + '\\n');
    } else if (message.method === 'tools/list') { ${onList} }
  }
});
setInterval(() => {}, 1000);
`,
  );
  closers.push(() => {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {
      // Already gone, which is what most of these tests are after.
    }
  });
  return {
    config: { transport: 'stdio', command: process.execPath, args: [script] },
    pid: () => Number(readFileSync(pidFile, 'utf8')),
  };
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it('stops a command that connected but offers no tools', async () => {
  const fixture = stdioServer('{}', '');

  const { opened, clients } = connect(fixture.config);
  const { unavailable } = await opened;

  expect(clients).toEqual([]);
  expect(unavailable[0]?.reason).toContain('does not support tools');
  await vi.waitFor(() => expect(running(fixture.pid())).toBe(false), { timeout: 5_000 });
});

it('stops a command that prints one endless line', async () => {
  const fixture = stdioServer(
    '{ tools: {} }',
    `const chunk = 'x'.repeat(1024 * 1024);
     const flood = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', flood); };
     flood();`,
  );

  const { opened } = connect(fixture.config);
  const { unavailable } = await opened;

  expect(unavailable[0]?.reason).toContain('MCP response too large');
  await vi.waitFor(() => expect(running(fixture.pid())).toBe(false), { timeout: 5_000 });
}, 20_000);

it('sends only a few answers at once to a server that floods requests', async () => {
  const pending: Array<() => void> = [];
  const fetcher = vi.fn(
    () => new Promise<Response>((done) => pending.push(() => done(new Response(null)))),
  ) as unknown as typeof fetch;
  const bounded = boundedMcpFetch(fetcher);

  const replies = Array.from({ length: 100 }, (_item, id) =>
    bounded('http://server.example/mcp', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id, result: {} }),
    }),
  );

  expect(fetcher).toHaveBeenCalledTimes(MCP_LIMITS.replies);

  for (const release of pending) release();
  await Promise.all(replies);
});

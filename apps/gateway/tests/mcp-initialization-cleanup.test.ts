import type { MCPTransport } from '@ai-sdk/mcp';
import type { McpServer, Run } from '@jian/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectMcpTools } from '../src/agent/mcp.js';
import { connectMcp } from '../src/agent/mcp-connect.js';
import { createNegotiatedMcpClient, type McpCleanupResource } from '../src/agent/mcp-negotiate.js';
import * as stdio from '../src/agent/mcp-stdio.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const server: McpServer = {
  name: 'local',
  transport: 'stdio',
  command: process.execPath,
  args: [],
  env: [],
  auth: 'none',
  headers: [],
  disabledTools: [],
};

function connection(registerCleanup?: (resource: McpCleanupResource) => void) {
  return {
    profileId: 'p',
    server,
    vault: { read: async () => undefined },
    fetcher: globalThis.fetch,
    signal: new AbortController().signal,
    registerCleanup,
  };
}

/** Real SDK initialization; only the transport boundary is synthetic. */
function peer(options: { fail?: boolean; modern?: boolean; close?: () => Promise<void> } = {}) {
  const start = vi.fn(async () => {});
  const close = vi.fn(options.close ?? (async () => {}));
  const transport: MCPTransport = {
    start,
    close,
    supportsProtocolVersionDiscovery: options.modern,
    async send(message) {
      if (!('id' in message) || !('method' in message)) return;
      if (options.fail || message.method === 'server/discover') {
        transport.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32022,
            message: options.modern
              ? 'Modern MCP serving is disabled; negotiate a supported legacy protocol'
              : 'initialization refused',
          },
        });
      } else {
        transport.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result:
            message.method === 'initialize'
              ? {
                  protocolVersion: '2025-03-26',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'peer', version: '1' },
                }
              : { tools: [] },
        });
      }
    },
  };
  return { transport, start, close };
}

afterEach(() => vi.restoreAllMocks());

describe('MCP ownership before initialization returns', () => {
  it('registers a real stdio transport before a failing handshake and confirms child close', async () => {
    const script = `process.stdin.on('data', data => {
      const m = JSON.parse(String(data));
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'refused'}})+'\\n');
    });`;
    const resources: McpCleanupResource[] = [];
    const registered = vi.fn((resource: McpCleanupResource) => resources.push(resource));
    await expect(
      connectMcp({
        ...connection(registered),
        server: { ...server, args: ['-e', script] },
      }),
    ).rejects.toThrow('refused');
    expect(registered).toHaveBeenCalledOnce();
    await expect(resources[0]?.close()).resolves.toBeUndefined();
  });

  it('retains pre-return cleanup in the runtime list when SDK init swallows close rejection', async () => {
    const failure = new Error('child close unconfirmed');
    const fake = peer({
      fail: true,
      close: async () => {
        throw failure;
      },
    });
    vi.spyOn(stdio, 'stdioTransport').mockReturnValue(fake.transport);
    const clients: McpCleanupResource[] = [];
    fake.start.mockImplementation(async () => {
      expect(clients).toHaveLength(1);
    });
    const result = await connectMcpTools(
      {
        profileId: 'p',
        profile: { mcpServers: [server] },
      } as unknown as Run,
      {},
      {
        clients,
        vault: connection().vault,
        secrets: new Set(),
        fetcher: globalThis.fetch,
        signal: new AbortController().signal,
      },
    );
    expect(result.unavailable[0]?.reason).toContain('cleanup failed');
    expect(clients).toHaveLength(1); // No SDK client was ever returned.
    expect((await Promise.allSettled(clients.map((resource) => resource.close())))[0]?.status).toBe(
      'rejected',
    );
    fake.close.mockResolvedValue(undefined);
    await expect(clients[0]?.close()).resolves.toBeUndefined();
  });

  it('surfaces the original cleanup rejection without a runtime registration callback', async () => {
    const failure = new Error('cleanup failed');
    const fake = peer({
      fail: true,
      close: async () => {
        throw failure;
      },
    });
    vi.spyOn(stdio, 'stdioTransport').mockReturnValue(fake.transport);
    const error = await connectMcp(connection()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(failure);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('awaits actual close after initialization abort, without racing or inheriting the abort signal', async () => {
    const gate = deferred();
    const controller = new AbortController();
    const fake = peer({ close: () => gate.promise });
    fake.transport.send = async () => {
      controller.abort(new Error('stop'));
    };
    vi.spyOn(stdio, 'stdioTransport').mockReturnValue(fake.transport);
    const resources: McpCleanupResource[] = [];
    let settled = false;
    const opening = connectMcp({
      ...connection((resource) => resources.push(resource)),
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    const rejected = expect(opening).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledOnce());
    const cleanup = resources[0]?.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.close.mock.calls[0]).toEqual([]);
    gate.resolve();
    await rejected;
    await cleanup;
  });

  it('waits for old close before fallback reuse and safely closes the successful client', async () => {
    const gate = deferred();
    const fake = peer({ modern: true, close: () => gate.promise });
    const resources: McpCleanupResource[] = [];
    const opening = createNegotiatedMcpClient({ transport: fake.transport }, (r) =>
      resources.push(r),
    );
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledOnce());
    expect(fake.start).toHaveBeenCalledOnce();
    gate.resolve();
    const client = await opening;
    expect(fake.start).toHaveBeenCalledTimes(2);
    expect(await client.tools()).toEqual({});
    await Promise.all([client.close(), resources[0]?.close()]);
    expect(fake.close).toHaveBeenCalledTimes(2);
  });

  it('does not retry a fallback-capable peer when its old transport close failed', async () => {
    const fake = peer({
      modern: true,
      close: async () => {
        throw new Error('close failed');
      },
    });
    await expect(createNegotiatedMcpClient({ transport: fake.transport })).rejects.toThrow(
      'cleanup failed',
    );
    expect(fake.start).toHaveBeenCalledOnce();
  });

  it('registers normal successful stdio acquisition and closes even if the SDK is already closed', async () => {
    const fake = peer();
    vi.spyOn(stdio, 'stdioTransport').mockReturnValue(fake.transport);
    const resources: McpCleanupResource[] = [];
    const client = await connectMcp(connection((resource) => resources.push(resource)));
    expect(await client.tools()).toEqual({});
    fake.transport.onclose?.(); // SDK close is now a no-op, not a cleanup confirmation.
    await client.close();
    expect(fake.close).not.toHaveBeenCalled();
    await resources[0]?.close();
    expect(fake.close).toHaveBeenCalledOnce();
  });
});

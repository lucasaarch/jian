import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  createNegotiatedMcpClient,
  shouldFallbackToLegacyInitialize,
  supportedProtocolVersions,
} from '../src/agent/mcp-negotiate.js';
import { probeMcpServer } from '../src/agent/mcp-probe.js';
import { createSafeFetch } from '../src/security/outbound.js';
import { testServices } from './helpers/services.js';

const ATLASSIAN_DISABLED =
  'Modern MCP serving is disabled; negotiate a supported legacy protocol version';

describe('MCP era fallback detection', () => {
  it('falls back when the server says modern serving is disabled', () => {
    expect(shouldFallbackToLegacyInitialize(new Error(ATLASSIAN_DISABLED))).toBe(true);
  });

  it('falls back on modern version errors that only list legacy revisions', () => {
    const error = Object.assign(new Error('Unsupported protocol version'), {
      code: -32022,
      data: { supported: ['2025-11-25', '2025-03-26'], requested: '2026-07-28' },
    });

    expect(supportedProtocolVersions(error)).toEqual(['2025-11-25', '2025-03-26']);
    expect(shouldFallbackToLegacyInitialize(error)).toBe(true);
  });

  it('does not fall back for a modern-only peer', () => {
    const error = Object.assign(new Error('Unsupported protocol version'), {
      code: -32022,
      data: { supported: ['2026-07-28'], requested: '2025-11-25' },
    });

    expect(shouldFallbackToLegacyInitialize(error)).toBe(false);
  });

  it('does not treat ordinary failures as era signals', () => {
    expect(shouldFallbackToLegacyInitialize(new Error('fetch failed'))).toBe(false);
    expect(
      shouldFallbackToLegacyInitialize(
        Object.assign(new Error('Method not found'), { code: -32601 }),
      ),
    ).toBe(false);
  });
});

type Mode = 'legacy-disabled-modern' | 'modern-only' | 'legacy-unknown-discover';

/**
 * Synthetic Streamable HTTP MCP peer. `legacy-disabled-modern` mirrors Atlassian v2: it
 * answers `server/discover` with a modern JSON-RPC refusal, then accepts `initialize`.
 */
function eraServer(mode: Mode) {
  return createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) {
      body += chunk;
    }

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

    if (message.method === 'server/discover') {
      if (mode === 'modern-only') {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              resultType: 'discover',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
              instructions: undefined,
              _meta: {
                'io.modelcontextprotocol/serverInfo': { name: 'modern', version: '1' },
              },
            },
          }),
        );

        return;
      }

      if (mode === 'legacy-disabled-modern') {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32022,
              message: ATLASSIAN_DISABLED,
              data: { supported: ['2025-11-25', '2025-03-26'], requested: '2026-07-28' },
            },
          }),
        );

        return;
      }

      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        }),
      );

      return;
    }

    if (message.method === 'initialize') {
      if (mode === 'modern-only') {
        response.writeHead(400, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32022,
              message: 'connection is serving the 2026-07-28 protocol; initialize is not accepted',
              data: { supported: ['2026-07-28'], requested: '2025-11-25' },
            },
          }),
        );

        return;
      }

      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'legacy', version: '1' },
          },
        }),
      );

      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          // Modern era replies require resultType; legacy initialize sessions omit it.
          ...(mode === 'modern-only' ? { resultType: 'tools' } : {}),
          tools: [
            {
              name: mode === 'modern-only' ? 'modern_tool' : 'legacy_tool',
              description: 'Synthetic tool',
              inputSchema: { type: 'object' },
            },
          ],
        },
      }),
    );
  });
}

async function withOrigin(mode: Mode, run: (origin: string) => Promise<void>) {
  const server = eraServer(mode);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    await run(origin);
  } finally {
    server.close();
  }
}

describe('MCP auto negotiation against synthetic peers', () => {
  it('falls back to initialize when modern serving is disabled', async () => {
    await withOrigin('legacy-disabled-modern', async (origin) => {
      const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
      const services = await testServices();
      const profile = await services.profiles.createProfile({
        name: 'Atlas',
        instructions: 'Help.',
        model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
        mcpServers: [{ name: 'atlassian', url: `${origin}/mcp` }],
      });

      try {
        const status = await probeMcpServer(profile, 'atlassian', services.vault, outbound.fetch);

        expect(status.reachable).toBe(true);
        expect(status.tools.map((tool) => tool.name)).toEqual(['legacy_tool']);
        expect(status.error).toBeUndefined();
      } finally {
        await outbound.close();
      }
    });
  });

  it('stays on modern discover when the peer is modern-only', async () => {
    await withOrigin('modern-only', async (origin) => {
      const client = await createNegotiatedMcpClient({
        transport: {
          type: 'http',
          url: `${origin}/mcp`,
          fetch: globalThis.fetch,
          redirect: 'error',
        },
        initializationOptions: { timeout: 5_000 },
        maxRetries: 0,
      });

      try {
        const tools = await client.tools();

        expect(Object.keys(tools)).toEqual(['modern_tool']);
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  });

  it('still falls back when discover is simply unknown', async () => {
    await withOrigin('legacy-unknown-discover', async (origin) => {
      const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
      const services = await testServices();
      const profile = await services.profiles.createProfile({
        name: 'Atlas',
        instructions: 'Help.',
        model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
        mcpServers: [{ name: 'docs', url: `${origin}/mcp` }],
      });

      try {
        const status = await probeMcpServer(profile, 'docs', services.vault, outbound.fetch);

        expect(status.reachable).toBe(true);
        expect(status.tools.map((tool) => tool.name)).toEqual(['legacy_tool']);
      } finally {
        await outbound.close();
      }
    });
  });
});

import type { McpStatus, Profile } from '@jian/contracts';
import { GatewayError } from '../core/errors.js';
import { createSafeFetch } from '../security/outbound.js';
import type { Vault } from '../security/vault.js';
import { connectMcp, MissingMcpValue } from './mcp-connect.js';
import type { McpOAuthProviders } from './types.js';

/**
 * Connects to one configured server and reports what it answered. This is the owner asking
 * "does this work", so a refusal is a result to show, not an error to raise — the only failure
 * is a server that is not configured at all.
 */
export async function probeMcpServer(
  profile: Profile,
  name: string,
  vault: Vault,
  fetcher?: typeof globalThis.fetch,
  oauth?: McpOAuthProviders,
): Promise<McpStatus> {
  const server = profile.mcpServers.find((item) => item.name === name);

  if (!server) {
    throw new GatewayError(404, 'MCP server not found');
  }

  const checkedAt = new Date().toISOString();
  const outbound = fetcher ? undefined : createSafeFetch();

  try {
    const client = await connectMcp({
      profileId: profile.id,
      server,
      vault,
      fetcher: fetcher ?? (outbound?.fetch as typeof globalThis.fetch),
      signal: AbortSignal.timeout(20_000),
      ...(server.auth === 'oauth' ? { authProvider: oauth?.(profile.id, server.name) } : {}),
    });

    try {
      const tools = Object.entries(await client.tools()).map(([toolName, definition]) => ({
        name: toolName,
        ...(typeof definition.description === 'string'
          ? { description: definition.description.slice(0, 600) }
          : {}),
      }));

      return { name, reachable: true, tools, checkedAt };
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    // The message is what the owner has to act on — a 401 means the credential, a timeout
    // means the address. It never carries a secret, which only ever travels in a header.
    const reason =
      error instanceof MissingMcpValue
        ? error.detail
        : error instanceof Error
          ? error.message
          : 'The server did not answer';

    return { name, reachable: false, tools: [], error: reason.slice(0, 300), checkedAt };
  } finally {
    await outbound?.close();
  }
}

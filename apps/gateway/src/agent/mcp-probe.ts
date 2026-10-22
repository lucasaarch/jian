import type { McpStatus, Profile } from '@jian/contracts';
import { GatewayError } from '../core/errors.js';
import { createSafeFetch } from '../security/outbound.js';
import type { Vault } from '../security/vault.js';
import { connectMcp, MissingMcpValue } from './mcp-connect.js';
import { mcpOauthClient } from './mcp-oauth-client.js';
import type { McpOAuthProviders } from './types.js';

/** Turns the SDK's DCR refusal into the action the owner must take. */
export function clarifyOauthError(message: string): string {
  if (/does not support dynamic client registration/i.test(message)) {
    return (
      'This auth server does not support dynamic client registration. ' +
      'For GitHub Copilot MCP, set JIAN_GITHUB_OAUTH_CLIENT_ID and ' +
      'JIAN_GITHUB_OAUTH_CLIENT_SECRET on the gateway (one OAuth App whose callback is ' +
      '/v1/mcp/oauth/callback under JIAN_PUBLIC_URL), then try again. ' +
      'Other servers: enter a client id under Advanced on the MCP server.'
    );
  }

  return message;
}

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
      ...(server.auth === 'oauth'
        ? { authProvider: oauth?.(profile.id, server.name, mcpOauthClient(server)) }
        : {}),
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
          ? clarifyOauthError(error.message)
          : 'The server did not answer';

    return { name, reachable: false, tools: [], error: reason.slice(0, 300), checkedAt };
  } finally {
    await outbound?.close();
  }
}

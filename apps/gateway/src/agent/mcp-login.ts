import { auth } from '@ai-sdk/mcp';
import type { McpServer, McpStatus } from '@jian/contracts';
import { GatewayError } from '../core/errors.js';
import type { GatewayVault } from '../security/gateway-vault.js';
import { McpOAuth } from './mcp-oauth.js';
import { mcpOauthClient } from './mcp-oauth-client.js';
import type { McpOAuthProviders } from './types.js';

/**
 * The sign-in an MCP server asks for. The SDK owns the exchange; this owns where the owner is
 * sent, where they come back to, and where the result is kept.
 *
 * An authorization URL lives only in memory: it is one step of one sign-in, it expires on its
 * own, and a gateway that restarts mid-flow should ask the owner to start again rather than
 * resume something nobody is waiting on.
 */
export class McpLogins {
  private readonly pending = new Map<string, string>();

  constructor(
    private readonly vault: Pick<GatewayVault, 'read' | 'put' | 'discard'>,
    /** The address the owner reaches this gateway on; the redirect has to come back to it. */
    private readonly publicUrl: string,
    private readonly fetcher: typeof globalThis.fetch = fetch,
  ) {}

  private callback(server: string): string {
    return new URL(`/v1/mcp-servers/${server}/oauth/callback`, this.publicUrl).toString();
  }

  /** Handed to the MCP client, which asks it for tokens and for somewhere to send the owner. */
  readonly provider: McpOAuthProviders = (server, oauth) =>
    new McpOAuth(this.vault, server, this.callback(server), this.pending, oauth);

  /** Where the owner has to go, if the last attempt decided they had to go somewhere. */
  authorizationUrl(server: string): string | undefined {
    return this.pending.get(server);
  }

  /** Finishes what the redirect brought back, and leaves the tokens where a run will find them. */
  async complete(configured: McpServer, code: string, state?: string): Promise<void> {
    if (!configured.url || configured.auth !== 'oauth') {
      throw new GatewayError(404, 'MCP server not found');
    }

    const server = configured.name;
    const result = await auth(this.provider(server, mcpOauthClient(configured)), {
      serverUrl: configured.url,
      authorizationCode: code,
      fetchFn: this.fetcher,
      ...(state ? { callbackState: state } : {}),
    });

    if (result !== 'AUTHORIZED') {
      throw new GatewayError(409, 'The authorization server did not complete the sign-in');
    }

    this.pending.delete(server);
  }

  /** The authorization URL a check produced, so the panel can offer it next to the result. */
  withAuthorization(status: McpStatus): McpStatus {
    const authorizationUrl = this.authorizationUrl(status.name);

    return authorizationUrl && !status.reachable ? { ...status, authorizationUrl } : status;
  }
}

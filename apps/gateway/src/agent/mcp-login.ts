import { auth } from '@ai-sdk/mcp';
import type { McpStatus, Profile } from '@jian/contracts';
import { GatewayError } from '../core/errors.js';
import type { Vault } from '../security/vault.js';
import { McpOAuth } from './mcp-oauth.js';
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
    private readonly vault: Vault,
    /** The address the owner reaches this gateway on; the redirect has to come back to it. */
    private readonly publicUrl: string,
    private readonly fetcher: typeof globalThis.fetch = fetch,
  ) {}

  private callback(profileId: string, server: string): string {
    return new URL(
      `/v1/profiles/${profileId}/mcp-servers/${server}/oauth/callback`,
      this.publicUrl,
    ).toString();
  }

  /** Handed to the MCP client, which asks it for tokens and for somewhere to send the owner. */
  readonly provider: McpOAuthProviders = (profileId, server) =>
    new McpOAuth(this.vault, profileId, server, this.callback(profileId, server), this.pending);

  /** Where the owner has to go, if the last attempt decided they had to go somewhere. */
  authorizationUrl(profileId: string, server: string): string | undefined {
    return this.pending.get(`${profileId}:${server}`);
  }

  /** Finishes what the redirect brought back, and leaves the tokens where a run will find them. */
  async complete(profile: Profile, server: string, code: string, state?: string): Promise<void> {
    const configured = profile.mcpServers.find((item) => item.name === server);

    if (!configured?.url || configured.auth !== 'oauth') {
      throw new GatewayError(404, 'MCP server not found');
    }

    const result = await auth(this.provider(profile.id, server), {
      serverUrl: configured.url,
      authorizationCode: code,
      fetchFn: this.fetcher,
      ...(state ? { callbackState: state } : {}),
    });

    if (result !== 'AUTHORIZED') {
      throw new GatewayError(409, 'The authorization server did not complete the sign-in');
    }

    this.pending.delete(`${profile.id}:${server}`);
  }

  /** The authorization URL a check produced, so the panel can offer it next to the result. */
  withAuthorization(profileId: string, status: McpStatus): McpStatus {
    const authorizationUrl = this.authorizationUrl(profileId, status.name);

    return authorizationUrl && !status.reachable ? { ...status, authorizationUrl } : status;
  }
}

import { randomUUID } from 'node:crypto';
import type { OAuthClientInformation, OAuthClientProvider } from '@ai-sdk/mcp';
import { mcpSecret } from '../profiles/service.js';
import type { Vault } from '../security/vault.js';
import { mcpOauthClientSecretKey } from './mcp-connect.js';
import { mcpOauthCallbackState } from './mcp-oauth-client.js';
import type { McpOAuthClient } from './types.js';

/**
 * What one server's sign-in leaves behind: the tokens, the client the authorization server
 * issued, and the two short-lived values that tie one redirect to the request that started it.
 */
type Stored = {
  tokens?: unknown;
  client?: unknown;
  server?: unknown;
  verifier?: string;
  state?: string;
  dynamic?: boolean;
};

const owner = (server: string) => `${mcpSecret(server)}:oauth`;

/**
 * The SDK runs the whole exchange — discovery, dynamic registration, PKCE, refresh — and asks
 * this for storage and for a place to send the owner. Everything it saves lands in the same
 * encrypted vault entry, so removing the server removes the sign-in with it.
 *
 * When the authorization server has no `registration_endpoint` (GitHub Copilot MCP, and others
 * that skip RFC 7591), a static client comes from the install GitHub OAuth App env vars, or
 * from an advanced per-server client id. `clientInformation` returns that instead of
 * attempting dynamic registration.
 *
 * `redirectToAuthorization` does not open a browser: nothing here has one. It records the URL
 * for the panel to show, and the sign-in finishes when the owner comes back through the
 * fixed MCP OAuth callback. OAuth `state` carries profile and server so that one redirect URI
 * works for every MCP server on the install.
 */
export class McpOAuth implements OAuthClientProvider {
  constructor(
    private readonly vault: Vault,
    private readonly profileId: string,
    private readonly server: string,
    private readonly callbackUrl: string,
    /** Where a pending authorization URL is left for the panel to read. */
    private readonly pending: Map<string, string>,
    /** Pre-registered client when the AS does not offer dynamic registration. */
    private readonly oauth?: McpOAuthClient,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private async read(): Promise<Stored> {
    const raw = await this.vault.read(this.profileId, owner(this.server));

    return raw ? (JSON.parse(raw) as Stored) : {};
  }

  private async write(patch: Stored): Promise<void> {
    const current = await this.read();

    await this.vault.put(
      this.profileId,
      owner(this.server),
      JSON.stringify({ ...current, ...patch }),
    );
  }

  get redirectUrl() {
    return this.callbackUrl;
  }

  get clientMetadata() {
    return {
      client_name: 'Jian',
      redirect_uris: [this.callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  async tokens() {
    return (await this.read()).tokens as never;
  }

  async saveTokens(tokens: unknown) {
    // The verifier and the state belong to the exchange that just finished.
    await this.write({ tokens, verifier: undefined, state: undefined });
  }

  async redirectToAuthorization(url: URL) {
    this.pending.set(`${this.profileId}:${this.server}`, url.toString());
  }

  async saveCodeVerifier(verifier: string) {
    await this.write({ verifier });
  }

  async codeVerifier() {
    const { verifier } = await this.read();

    if (!verifier) {
      throw new Error('This sign-in was not started on this gateway');
    }

    return verifier;
  }

  private async staticClientSecret(): Promise<string | undefined> {
    if (this.oauth?.secretFromEnv) {
      return this.env[this.oauth.secretFromEnv]?.trim() || undefined;
    }

    return this.vault.read(this.profileId, mcpOauthClientSecretKey(this.server));
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const stored = (await this.read()).client as OAuthClientInformation | undefined;

    if (stored) {
      return stored;
    }

    if (!this.oauth?.clientId) {
      return undefined;
    }

    const clientSecret = await this.staticClientSecret();

    return {
      client_id: this.oauth.clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    };
  }

  async saveClientInformation(client: unknown) {
    await this.write({ client, dynamic: true });
  }

  async isClientInformationDynamicallyRegistered() {
    return (await this.read()).dynamic === true;
  }

  async authorizationServerInformation() {
    return (await this.read()).server as never;
  }

  async saveAuthorizationServerInformation(server: unknown) {
    await this.write({ server });
  }

  async state() {
    const nonce = randomUUID();

    await this.write({ state: nonce });

    return mcpOauthCallbackState(this.profileId, this.server, nonce);
  }

  async saveState(state: string) {
    // The SDK may hand back the compound callback state; only the nonce is stored.
    const nonce = state.includes('.') ? (state.split('.').at(-1) ?? state) : state;

    await this.write({ state: nonce });
  }

  async storedState() {
    const nonce = (await this.read()).state;

    return nonce ? mcpOauthCallbackState(this.profileId, this.server, nonce) : undefined;
  }

  /**
   * Called when the server says the credentials are no longer good. Dropping only what is
   * named keeps a refused token from costing the owner the client registration too.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier') {
    if (scope === 'all') {
      await this.vault.discard(this.profileId, owner(this.server));

      return;
    }

    await this.write({
      ...(scope === 'client' ? { client: undefined, dynamic: undefined } : {}),
      ...(scope === 'tokens' ? { tokens: undefined } : {}),
      ...(scope === 'verifier' ? { verifier: undefined } : {}),
    });
  }
}

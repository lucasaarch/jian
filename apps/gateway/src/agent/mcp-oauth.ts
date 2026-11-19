import { randomUUID } from 'node:crypto';
import type { OAuthClientInformation, OAuthClientProvider } from '@ai-sdk/mcp';
import type { GatewayVault } from '../security/gateway-vault.js';
import { NO_CLIENT_DOCUMENT, wantsClientDocument } from './mcp-client-document.js';
import { mcpOauthClientSecretKey, mcpSecret } from './mcp-connect.js';
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
  /**
   * The authorization server takes this gateway's client id metadata document. Kept as a mark,
   * not as the id: the id is worked out again each time, so it follows `JIAN_PUBLIC_URL`.
   */
  document?: boolean;
};

/**
 * Being a client by a metadata document (`mcp-client-document.ts`): its address, absent when
 * this gateway has no HTTPS one, and the client that reads the authorization server's metadata
 * to tell whether it wants one.
 */
export type ClientDocument = {
  url: string | undefined;
  fetch: typeof globalThis.fetch;
};

const owner = (server: string) => `${mcpSecret(server)}:oauth`;

/**
 * The SDK runs the whole exchange — discovery, dynamic registration, PKCE, refresh — and asks
 * this for storage and for a place to send the owner. Everything it saves lands in the same
 * encrypted vault entry, so removing the server removes the sign-in with it.
 *
 * When the authorization server has no `registration_endpoint` (GitHub Copilot MCP, and others
 * that skip RFC 7591), the owner supplies a pre-registered client id (and optional secret).
 * `clientInformation` returns those instead of attempting dynamic registration. One that takes a
 * client id metadata document instead (ElevenLabs) needs nothing from the owner: the client id
 * is the document's address on this gateway. The SDK asks for the client before it shows this
 * the server's metadata, so `validateAuthorizationServerURL`, which it calls first, reads that
 * metadata to choose, once, before any client exists.
 *
 * `redirectToAuthorization` does not open a browser: nothing here has one. It records the URL
 * for the panel to show, and the sign-in finishes when the owner comes back through the
 * callback route.
 */
export class McpOAuth implements OAuthClientProvider {
  constructor(
    private readonly vault: Pick<GatewayVault, 'read' | 'put' | 'discard'>,
    private readonly server: string,
    private readonly callbackUrl: string,
    /** Where a pending authorization URL is left for the panel to read. */
    private readonly pending: Map<string, string>,
    /** Pre-registered client when the AS does not offer dynamic registration. */
    private readonly oauth?: McpOAuthClient,
    private readonly options: { env?: NodeJS.ProcessEnv; document?: ClientDocument } = {},
  ) {}

  private async read(): Promise<Stored> {
    const raw = await this.vault.read(owner(this.server));

    return raw ? (JSON.parse(raw) as Stored) : {};
  }

  private async write(patch: Stored): Promise<void> {
    const current = await this.read();

    await this.vault.put(owner(this.server), JSON.stringify({ ...current, ...patch }));
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
    this.pending.set(this.server, url.toString());
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
      return (this.options.env ?? process.env)[this.oauth.secretFromEnv]?.trim() || undefined;
    }

    return this.vault.read(mcpOauthClientSecretKey(this.server));
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const { client, document } = await this.read();

    if (client) {
      return client as OAuthClientInformation;
    }

    if (this.oauth?.clientId) {
      const clientSecret = await this.staticClientSecret();

      return {
        client_id: this.oauth.clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      };
    }

    if (!document) {
      return undefined;
    }

    // Signed in by a document, and the gateway has since lost its HTTPS address: undefined
    // would send the SDK to register, and the owner would read a refusal about the wrong thing.
    if (!this.options.document?.url) {
      throw new Error(NO_CLIENT_DOCUMENT);
    }

    return { client_id: this.options.document.url };
  }

  /**
   * Chooses how this gateway becomes the authorization server's client, before the SDK asks
   * which client it is. A stored or pre-registered client needs no choice, and neither does a
   * server that registers clients, which the SDK does itself; only one that takes a document
   * and nothing else makes this one, and refuses where the document could not be fetched.
   */
  async validateAuthorizationServerURL(_server: string | URL, authorizationServer: string | URL) {
    const document = this.options.document;

    if (!document || this.oauth?.clientId) return;

    const stored = await this.read();

    if (stored.client || stored.document) return;
    if (!(await wantsClientDocument(authorizationServer, document.fetch))) return;
    if (!document.url) throw new Error(NO_CLIENT_DOCUMENT);

    await this.write({ document: true });
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
    const state = randomUUID();

    await this.write({ state });

    return state;
  }

  async saveState(state: string) {
    await this.write({ state });
  }

  async storedState() {
    return (await this.read()).state;
  }

  /**
   * Called when the server says the credentials are no longer good. Dropping only what is
   * named keeps a refused token from costing the owner the client registration too.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier') {
    if (scope === 'all') {
      await this.vault.discard(owner(this.server));

      return;
    }

    await this.write({
      ...(scope === 'client' ? { client: undefined, dynamic: undefined, document: undefined } : {}),
      ...(scope === 'tokens' ? { tokens: undefined } : {}),
      ...(scope === 'verifier' ? { verifier: undefined } : {}),
    });
  }
}

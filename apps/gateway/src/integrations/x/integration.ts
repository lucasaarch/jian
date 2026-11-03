import { randomUUID } from 'node:crypto';
import type { XIntegrationStatus } from '@jian/contracts';
import { asc, eq, lt } from 'drizzle-orm';
import { GatewayError } from '../../core/errors.js';
import type { GatewayVault } from '../../security/gateway-vault.js';
import type { Store } from '../../storage/database.js';
import { xAccounts, xConnectStates } from '../../storage/schema.js';
import { X_SCOPES } from './catalog/index.js';
import { XFailure } from './failures.js';
import {
  authorizationUrl,
  newChallenge,
  requestTokens,
  STATE_LIFETIME_MS,
  stateHash,
  X_API,
  type XApp,
  xCallbackUrl,
} from './oauth.js';
import { accountLock, xAccountKey } from './tokens.js';

const APP_KEY = 'x-app';
/** The old Integrations address, which every panel opens: the new ones as Apps. */
const RETURN_PATH = '/settings/integrations';

/** Why connecting an account failed, as the panel is told in `?reason=`. */
export type XConnectFailure = 'denied' | 'expired' | 'exchange' | 'profile' | 'scope' | 'gateway';

export type XActingAccount = { id: string; userId: string; handle: string; scopes: string[] };

const handleOf = (name: string) => name.trim().replace(/^@/, '').toLowerCase();

/**
 * The installation's X app and the accounts connected through it, each lent to agents one by one.
 * Credentials and tokens stay in the vault: the database holds only what the panel may show.
 */
export class XIntegration {
  constructor(
    private readonly store: Store,
    private readonly vault: Pick<GatewayVault, 'read' | 'put' | 'discard'>,
    private readonly publicUrl: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  private get callbackUrl(): string | undefined {
    return xCallbackUrl(this.publicUrl);
  }

  async app(reader = this.store.db): Promise<XApp | undefined> {
    const raw = await this.vault.read(APP_KEY, reader);

    return raw ? (JSON.parse(raw) as XApp) : undefined;
  }

  /** What the panel may know: the secret's presence is `configured`, and it is never read back. */
  async status(): Promise<XIntegrationStatus> {
    const app = await this.app();
    const rows = await this.store.db.select().from(xAccounts).orderBy(asc(xAccounts.handle));
    const { callbackUrl } = this;

    return {
      configured: Boolean(app),
      ...(app ? { clientId: app.clientId } : {}),
      ...(callbackUrl ? { callbackUrl } : {}),
      accounts: rows.map((row) => ({
        id: row.id,
        userId: row.xUserId,
        handle: row.handle,
        name: row.name,
        status: row.status,
        missingScopes: X_SCOPES.filter((scope) => !row.scopes.includes(scope)),
        connectedAt: row.connectedAt.toISOString(),
      })),
    };
  }

  async saveApp(input: XApp): Promise<XIntegrationStatus> {
    await this.vault.put(
      APP_KEY,
      JSON.stringify({ clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim() }),
    );

    return this.status();
  }

  /**
   * Starts a sign-in. Its state and verifier live in the database, as the owner's browser may come
   * back to any worker, and a gateway restarted in between can still finish it. The state is kept
   * only by its hash. The verifier is useless without the code X sends and the app's secret, and
   * lives no longer than the state does.
   */
  async start(returnOrigin: string | undefined): Promise<{ url: string }> {
    const { callbackUrl, publicUrl } = this;

    if (!callbackUrl || !publicUrl) {
      throw new GatewayError(
        503,
        "Set JIAN_PUBLIC_URL to this gateway's HTTPS address, or to http://127.0.0.1 on this computer, before connecting an X account.",
      );
    }

    const app = await this.app();

    if (!app) {
      throw new GatewayError(409, "Save the X app's client id and secret first.");
    }

    const origin = new URL(returnOrigin || publicUrl).origin;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);

    if (origin !== new URL(publicUrl).origin && !local) {
      throw new GatewayError(400, 'The integration must be started from this Jian panel.');
    }

    const { state, verifier, challenge } = newChallenge();
    const now = this.clock();

    await this.store.transaction('gateway', async (tx) => {
      await tx.delete(xConnectStates).where(lt(xConnectStates.expiresAt, new Date(now)));
      await tx.insert(xConnectStates).values({
        hash: stateHash(state),
        verifier,
        returnTo: `${origin}${RETURN_PATH}`,
        expiresAt: new Date(now + STATE_LIFETIME_MS),
        createdAt: new Date(now),
      });
    });

    return {
      url: authorizationUrl({ clientId: app.clientId, redirectUri: callbackUrl, state, challenge }),
    };
  }

  /** Takes a state once: whoever deletes the row owns it, so a replay finds nothing. */
  private async takeState(state: string | undefined) {
    if (!state) return undefined;

    const [row] = await this.store.transaction('gateway', (tx) =>
      tx
        .delete(xConnectStates)
        .where(eq(xConnectStates.hash, stateHash(state)))
        .returning(),
    );

    return row;
  }

  private fallback(): string {
    return this.publicUrl ? new URL(RETURN_PATH, this.publicUrl).toString() : RETURN_PATH;
  }

  /** Where the owner goes after X sent them back, having connected the account or not. */
  async finish(query: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
  }): Promise<{ location: string; failure?: XConnectFailure; cause?: unknown }> {
    const pending = await this.takeState(query.state);
    const back = pending?.returnTo ?? this.fallback();
    const failed = (failure: XConnectFailure) => ({
      location: `${back}?x=failed&reason=${failure}`,
      failure,
    });

    if (!pending || pending.expiresAt.getTime() <= this.clock()) return failed('expired');
    if (query.error === 'invalid_scope') return failed('scope');
    if (query.error || !query.code) return failed('denied');

    const app = await this.app();
    const redirectUri = this.callbackUrl;

    if (!app || !redirectUri) return failed('gateway');

    const exchange = await requestTokens(
      this.fetcher,
      app,
      {
        grant_type: 'authorization_code',
        code: query.code,
        redirect_uri: redirectUri,
        code_verifier: pending.verifier,
      },
      this.clock(),
    );

    if (exchange.kind !== 'ok') return failed('exchange');

    const user = await this.whoIs(exchange.tokens.accessToken);

    if (!user) return failed('profile');

    try {
      const now = new Date(this.clock());

      await this.store.transaction('gateway', async (tx) => {
        const [row] = await tx
          .insert(xAccounts)
          .values({
            id: randomUUID(),
            xUserId: user.id,
            handle: user.username,
            name: user.name,
            status: 'connected',
            scopes: exchange.tokens.scopes,
            connectedAt: now,
            updatedAt: now,
          })
          // The same person connecting again keeps the agents it was lent to.
          .onConflictDoUpdate({
            target: xAccounts.xUserId,
            set: {
              handle: user.username,
              name: user.name,
              status: 'connected',
              scopes: exchange.tokens.scopes,
              updatedAt: now,
            },
          })
          .returning({ id: xAccounts.id });

        if (!row) throw new Error('The account was not saved');

        await this.vault.put(xAccountKey(row.id), JSON.stringify(exchange.tokens), tx);
      });
    } catch (cause) {
      // X has granted it by now, so this is the only trace of what went wrong: the route logs it.
      return { ...failed('gateway'), cause };
    }

    return { location: `${back}?x=connected` };
  }

  private async whoIs(accessToken: string) {
    try {
      const response = await this.fetcher(`${X_API}/2/users/me?user.fields=id,name,username`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json()) as {
        data?: { id?: unknown; name?: unknown; username?: unknown };
      };
      const { id, name, username } = body.data ?? {};

      return response.ok && typeof id === 'string' && typeof username === 'string'
        ? { id, username, name: typeof name === 'string' ? name : username }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Lets an account go: its links with it, by cascade, and its tokens from the vault. */
  async disconnect(accountId: string): Promise<{ id: string }> {
    const removed = await this.store.transaction(accountLock(accountId), async (tx) => {
      const rows = await tx
        .delete(xAccounts)
        .where(eq(xAccounts.id, accountId))
        .returning({ id: xAccounts.id });

      await this.vault.discard(xAccountKey(accountId), tx);

      return rows.length > 0;
    });

    if (!removed) throw new GatewayError(404, 'X account not found');

    return { id: accountId };
  }

  /** Every connected account: each is there for every agent the moment it is connected. */
  async accounts(): Promise<XActingAccount[]> {
    return this.store.db
      .select({
        id: xAccounts.id,
        userId: xAccounts.xUserId,
        handle: xAccounts.handle,
        scopes: xAccounts.scopes,
      })
      .from(xAccounts)
      .orderBy(asc(xAccounts.handle));
  }

  /**
   * The account a call acts as, asked of the database at the moment of the call: a schema built
   * at the start of a run, or a call approved an hour later, is no proof it is still connected.
   */
  async resolve(asked: string | undefined): Promise<XActingAccount> {
    const accounts = await this.accounts();

    if (asked !== undefined) {
      const account = accounts.find(({ handle }) => handleOf(handle) === handleOf(asked));

      if (!account) {
        throw new XFailure(403, `@${handleOf(asked)} is not a connected X account.`);
      }

      return account;
    }

    const [only, ...others] = accounts;

    if (!only) throw new XFailure(403, 'No X account is connected.');
    if (others.length > 0) {
      throw new XFailure(
        400,
        `Say which account acts: ${accounts.map(({ handle }) => `@${handle}`).join(', ')}.`,
      );
    }

    return only;
  }
}

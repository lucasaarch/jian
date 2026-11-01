import { eq } from 'drizzle-orm';
import type { GatewayVault } from '../../security/gateway-vault.js';
import type { Queryable, Store } from '../../storage/database.js';
import { xAccounts } from '../../storage/schema.js';
import { reconnect, XFailure } from './failures.js';
import { requestTokens, type XApp, type XTokenSet } from './oauth.js';

/** A token this close to expiring is renewed first, in milliseconds. */
const EXPIRY_MARGIN_MS = 60_000;

export const xAccountKey = (accountId: string) => `x-account:${accountId}`;
/** The lock of one account's tokens. */
export const accountLock = (accountId: string) => `x-account:${accountId}`;

type Renewal =
  | { kind: 'ok'; tokens: XTokenSet }
  | { kind: 'gone' }
  | { kind: 'refused' }
  | { kind: 'unavailable' };

/**
 * Each account's access token, renewed when it runs out.
 *
 * X rotates the refresh token on every use: of two concurrent refreshes the second presents a dead
 * token and ends the connection. So a renewal happens inside the account's advisory lock, which
 * holds across workers, and re-reads after taking it: whoever waited finds the first one's token
 * and makes no call. The lock is held through X's answer, bounded by the token endpoint's timeout;
 * on a local gateway's single connection the whole database waits that long, about every two hours.
 * A commit lost after X answered would still lose the new token, and no ordering can prevent that.
 */
export class XTokens {
  constructor(
    private readonly store: Store,
    private readonly vault: Pick<GatewayVault, 'read' | 'put'>,
    private readonly app: (reader: Queryable) => Promise<XApp | undefined>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  private fresh(tokens: XTokenSet) {
    return tokens.expiresAt - EXPIRY_MARGIN_MS > this.clock();
  }

  /** A token to call X with, renewing first when it is about to expire. */
  async current(account: { id: string; handle: string }): Promise<XTokenSet> {
    const raw = await this.vault.read(xAccountKey(account.id));

    if (!raw) throw new XFailure(409, reconnect(account.handle));

    const tokens = JSON.parse(raw) as XTokenSet;

    return this.fresh(tokens) ? tokens : this.renew(account, tokens.accessToken);
  }

  /** A new token in place of `stale`, which X has refused or which has expired. */
  async renew(account: { id: string; handle: string }, stale: string): Promise<XTokenSet> {
    const outcome = await this.store.transaction(
      accountLock(account.id),
      async (tx): Promise<Renewal> => {
        const raw = await this.vault.read(xAccountKey(account.id), tx);

        if (!raw) return { kind: 'gone' };

        const tokens = JSON.parse(raw) as XTokenSet;

        // Someone else renewed it while this waited for the lock.
        if (tokens.accessToken !== stale && this.fresh(tokens)) return { kind: 'ok', tokens };

        const app = await this.app(tx);

        if (!app) return { kind: 'gone' };

        const result = await requestTokens(
          this.fetcher,
          app,
          { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
          this.clock(),
          tokens.scopes,
        );

        if (result.kind === 'unavailable') return result;

        const now = new Date(this.clock());

        if (result.kind === 'refused') {
          // Returned, not thrown: throwing here would roll this mark back with the transaction.
          await tx
            .update(xAccounts)
            .set({ status: 'needs_attention', updatedAt: now })
            .where(eq(xAccounts.id, account.id));

          return { kind: 'refused' };
        }

        await this.vault.put(xAccountKey(account.id), JSON.stringify(result.tokens), tx);
        await tx
          .update(xAccounts)
          .set({ status: 'connected', scopes: result.tokens.scopes, updatedAt: now })
          .where(eq(xAccounts.id, account.id));

        return result;
      },
    );

    if (outcome.kind === 'ok') return outcome.tokens;
    if (outcome.kind === 'unavailable') {
      throw new XFailure(
        502,
        'X did not answer while renewing the sign-in. Try again in a moment.',
      );
    }

    throw new XFailure(409, reconnect(account.handle));
  }
}

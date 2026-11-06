import { eq, like, or } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import type { Queryable, Store } from '../storage/database.js';
import { gatewaySecrets } from '../storage/schema.js';
import type { EncryptedSecret, SecretBox } from './crypto.js';

/**
 * The lock key for anything the installation owns as a whole. Profile work is serialized per
 * profile; this is the one scope above that, and it is a constant because there is one of it.
 */
export const GATEWAY_SCOPE = 'gateway';

/**
 * Encrypted storage for the credentials the whole installation shares — today a vendor key or
 * an OAuth token. Kept apart from the per-profile vault so that deleting a profile takes its
 * own secrets with it and never the ones its siblings are still using.
 */
export class GatewayVault {
  constructor(
    private readonly store: Store,
    private readonly box: SecretBox,
    private readonly clock: Clock = Date.now,
  ) {}

  private aad(owner: string) {
    return `jian:gateway-secret:${owner}`;
  }

  async put(owner: string, secret: string, tx?: Queryable): Promise<void> {
    const write = async (transaction: Queryable) => {
      const envelope = this.box.encrypt(secret, this.aad(owner));
      const now = new Date(this.clock());

      await transaction
        .insert(gatewaySecrets)
        .values({ name: owner, envelope, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: gatewaySecrets.name, set: { envelope, updatedAt: now } });
    };

    await (tx ? write(tx) : this.store.transaction(GATEWAY_SCOPE, write));
  }

  async read(owner: string, reader: Queryable = this.store.db): Promise<string | undefined> {
    const [row] = await reader
      .select({ envelope: gatewaySecrets.envelope })
      .from(gatewaySecrets)
      .where(eq(gatewaySecrets.name, owner))
      .limit(1);

    return row ? this.box.decrypt(row.envelope as EncryptedSecret, this.aad(owner)) : undefined;
  }

  async discard(owner: string, tx?: Queryable): Promise<void> {
    const remove = async (transaction: Queryable) => {
      await transaction.delete(gatewaySecrets).where(eq(gatewaySecrets.name, owner));
    };

    await (tx ? remove(tx) : this.store.transaction(GATEWAY_SCOPE, remove));
  }

  /**
   * Moves `from` and every secret under it (`from:…`) to the same place under `to`. Each is read
   * and written again, since a ciphertext is bound to the name it was written under.
   */
  async move(from: string, to: string, tx: Queryable): Promise<void> {
    const escaped = from.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = await tx
      .select({ name: gatewaySecrets.name })
      .from(gatewaySecrets)
      .where(or(eq(gatewaySecrets.name, from), like(gatewaySecrets.name, `${escaped}:%`)));

    for (const { name } of rows) {
      const value = await this.read(name, tx);
      if (value !== undefined) await this.put(`${to}${name.slice(from.length)}`, value, tx);
      await this.discard(name, tx);
    }
  }

  /**
   * Reads, transforms and rewrites under the installation lock, so a refreshed OAuth token
   * cannot be overwritten by a concurrent refresh that started from the older value.
   */
  async refresh(owner: string, transform: (secret: string) => Promise<string>): Promise<string> {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const current = await this.read(owner, tx);

      if (current === undefined) {
        throw new Error('Secret is not configured');
      }

      const next = await transform(current);

      if (next !== current) {
        await this.put(owner, next, tx);
      }

      return next;
    });
  }
}

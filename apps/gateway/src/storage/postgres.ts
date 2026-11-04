import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import type { Database, Queryable, Store } from './database.js';
import { MIGRATION_LOCK, migrationsFolder } from './database.js';
import * as schema from './schema.js';

export class PostgresStore implements Store {
  private readonly pool: Pool;
  private readonly connectionString: string;
  private listener: Client | undefined;
  private readonly listening: Promise<void>;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly client: ReturnType<typeof drizzle<typeof schema>>;
  private listenerReady = false;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeRetry: (() => void) | undefined;
  private stopListening: (() => void) | undefined;
  readonly db: Database;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = new Pool({ connectionString, max: 10 });
    this.listening = this.listen();
    void this.listening.catch(() => {});
    this.client = drizzle(this.pool, { schema, casing: 'snake_case' });
    this.db = this.client as unknown as Database;
  }

  private async listen(): Promise<void> {
    let retryIn = 1_000;

    while (!this.closed) {
      const listener = new Client({ connectionString: this.connectionString });
      let disconnect!: () => void;
      let disconnected = false;
      const dropped = new Promise<void>((resolve) => {
        disconnect = resolve;
      });
      const lost = () => {
        disconnected = true;
        disconnect();
      };
      let connectedAt = 0;

      this.listener = listener;
      this.listenerReady = false;
      this.stopListening = lost;
      listener.on('notification', (message) => {
        if (message.channel === 'jian_events' && message.payload) this.wake(message.payload);
      });
      listener.on('error', lost);
      listener.on('end', lost);

      try {
        const ready = listener.connect().then(async () => {
          if (this.closed || disconnected) return;
          await listener.query('LISTEN jian_events');
        });
        await Promise.race([ready, dropped]);
        if (this.closed) return;
        if (!disconnected) {
          this.listenerReady = true;
          connectedAt = Date.now();
          this.wakeAll();
          await dropped;
        }
      } catch {
        // A failed or dropped listener must not leave every event stream on its polling fallback.
      } finally {
        if (this.listener === listener) {
          this.listener = undefined;
          this.listenerReady = false;
        }
        if (this.stopListening === lost) this.stopListening = undefined;
        if (!this.closed) await listener.end().catch(() => {});
      }

      if (this.closed) return;
      if (connectedAt && Date.now() - connectedAt >= 30_000) retryIn = 1_000;
      await new Promise<void>((resolve) => {
        const done = () => {
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = undefined;
          this.wakeRetry = undefined;
          resolve();
        };
        this.retryTimer = setTimeout(done, retryIn);
        this.wakeRetry = done;
      });
      retryIn = Math.min(retryIn * 2, 30_000);
    }
  }

  private wake(profileId: string): void {
    const waiters = this.waiters.get(profileId);
    if (!waiters) return;
    this.waiters.delete(profileId);
    for (const resolve of waiters) resolve();
  }

  private wakeAll(): void {
    for (const profileId of this.waiters.keys()) this.wake(profileId);
  }

  waitForEvent(profileId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', done);
        const waiters = this.waiters.get(profileId);
        waiters?.delete(done);
        if (!waiters?.size) this.waiters.delete(profileId);
        resolve();
      };
      const current = this.waiters.get(profileId) ?? new Set<() => void>();
      current.add(done);
      this.waiters.set(profileId, current);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  }

  async migrate(): Promise<void> {
    const connection = await this.pool.connect();

    try {
      // Held for the whole run and released with the session, so a worker that dies mid
      // migration does not leave the next one waiting forever.
      await connection.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      await migrate(this.client, { migrationsFolder });
    } finally {
      await connection.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
      connection.release();
    }
  }

  async transaction<T>(profileId: string, body: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => {
      // Hashed to a bigint because an advisory lock takes numbers, not a uuid.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${profileId}, 0))`);

      return body(tx as unknown as Queryable);
    });
  }

  async close(): Promise<void> {
    const listener = this.listener;
    const listenerReady = this.listenerReady;
    this.closed = true;
    this.stopListening?.();
    this.wakeRetry?.();
    for (const profileId of this.waiters.keys()) this.wake(profileId);

    const ending = listener?.end().catch(() => {});
    await this.listening.catch(() => {});
    if (listener && !listenerReady) listener.connection.stream.destroy();
    await ending;
    await this.pool.end();
  }
}

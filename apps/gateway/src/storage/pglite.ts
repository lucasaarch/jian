import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database, Queryable, Store } from './database.js';
import { migrationsFolder } from './database.js';
import * as schema from './schema.js';

/**
 * PostgreSQL compiled to run inside this process, its data in one directory: the store of a
 * gateway that runs on one computer for one owner, such as the desktop app's, with no server to
 * install. The schema and migrations are the server's own.
 *
 * One connection serves everything, so transactions take turns. A transaction must not wait on
 * a query made outside it: that query would wait for the transaction, and neither would end.
 */
export class PGliteStore implements Store {
  private readonly client: PGlite;
  private readonly drizzled: ReturnType<typeof drizzle<typeof schema>>;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly listening: Promise<unknown>;
  readonly db: Database;

  private constructor(client: PGlite) {
    this.client = client;
    this.drizzled = drizzle(client, { schema, casing: 'snake_case' });
    this.db = this.drizzled as unknown as Database;
    // Commits notify on jian_events, as on a server; here the notice never leaves the process.
    this.listening = client.listen('jian_events', (profileId) => {
      for (const resolve of this.waiters.get(profileId) ?? []) resolve();
      this.waiters.delete(profileId);
    });
  }

  /** The database in `dataDir`, created on first use. */
  static async open(dataDir: string): Promise<PGliteStore> {
    return new PGliteStore(await PGlite.create(dataDir));
  }

  async migrate(): Promise<void> {
    // Nothing else opens this directory, so there is no other migrator to wait for.
    await migrate(this.drizzled, { migrationsFolder });
  }

  async transaction<T>(profileId: string, body: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.drizzled.transaction(async (tx) => {
      // Taken for parity with the server: code that relies on the lock reads the same here.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${profileId}, 0))`);
      return body(tx as unknown as Queryable);
    });
  }

  waitForEvent(profileId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return this.listening.then(
      () =>
        new Promise<void>((resolve) => {
          const done = () => {
            signal.removeEventListener('abort', done);
            this.waiters.get(profileId)?.delete(done);
            resolve();
          };
          const current = this.waiters.get(profileId) ?? new Set<() => void>();
          current.add(done);
          this.waiters.set(profileId, current);
          signal.addEventListener('abort', done, { once: true });
        }),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

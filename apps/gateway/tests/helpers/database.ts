import { PGlite } from '@electric-sql/pglite';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database, Queryable, Store } from '../../src/storage/database.js';
import { migrationsFolder } from '../../src/storage/database.js';
import * as schema from '../../src/storage/schema.js';
import {
  type QueryOutsideTransaction,
  SingleConnection,
} from '../../src/storage/single-connection.js';

/**
 * A real PostgreSQL, compiled to run inside the test process. The schema is the one that
 * ships, applied from the same migration files, so a test failing here is a test that would
 * fail in production. Concurrency across connections is not simulated: what needs two workers
 * at once belongs in the suite that talks to a server.
 */
let shared: Promise<TestStore> | undefined;

/**
 * What the store refused since the last test: queries that would have hung the desktop app's
 * gateway. Kept here because the code under test may catch the error; `tests/setup.ts` fails the
 * test that made one.
 */
export const outsideTransactions: QueryOutsideTransaction[] = [];

export class TestStore implements Store {
  private readonly client: PGlite;
  private readonly drizzled: ReturnType<typeof drizzle<typeof schema>>;
  private readonly connection: SingleConnection;
  readonly db: Database;

  private constructor(client: PGlite) {
    this.connection = new SingleConnection(client, (error) => outsideTransactions.push(error));
    this.client = client;
    this.drizzled = drizzle(client, { schema, casing: 'snake_case' });
    this.db = this.drizzled as unknown as Database;
  }

  /**
   * One database per worker process, emptied between tests. Starting a fresh one each time
   * costs a quarter of a second, which across the suite is most of its runtime.
   */
  static async create(): Promise<TestStore> {
    shared ??= (async () => {
      const store = new TestStore(new PGlite());

      await store.migrate();

      return store;
    })();

    const store = await shared;

    await store.empty();

    return store;
  }

  /** Cascades from every table, so a leftover row never explains a passing test. */
  async empty(): Promise<void> {
    const names = Object.values(schema as Record<string, unknown>)
      .filter((value) => is(value, PgTable))
      .map((table) => `"${getTableName(table as PgTable)}"`)
      .join(', ');

    await this.client.exec(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  }

  migrate(): Promise<void> {
    return migrate(this.drizzled, { migrationsFolder });
  }

  async transaction<T>(profileId: string, body: (tx: Queryable) => Promise<T>): Promise<T> {
    const opened = this.connection.opening();
    return this.drizzled.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${profileId}, 0))`);

      return this.connection.body(opened, () => body(tx as unknown as Queryable));
    });
  }

  /** The worker owns the database; a test closing it would take the next test with it. */
  async close(): Promise<void> {}

  async waitForEvent(_profileId: string, _signal: AbortSignal): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

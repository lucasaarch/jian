import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGliteStore } from '../src/storage/pglite.js';
import { QueryOutsideTransaction } from '../src/storage/single-connection.js';

describe('the gateway store kept in a directory', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function open() {
    const dir = await mkdtemp(join(tmpdir(), 'jian-pglite-'));
    dirs.push(dir);
    return dir;
  }

  it('keeps what was written after it is closed and opened again', async () => {
    const dir = await open();
    const first = await PGliteStore.open(dir);
    await first.migrate();
    await first.db.execute(sql`create table kept (value text)`);
    await first.db.execute(sql`insert into kept values ('still here')`);
    await first.close();

    const second = await PGliteStore.open(dir);
    await second.migrate();
    const rows = (await second.db.execute(sql`select value from kept`)) as unknown as {
      rows: unknown[];
    };
    expect(rows.rows).toEqual([{ value: 'still here' }]);
    await second.close();
  }, 60_000);

  it('wakes a stream waiting on a profile when a transaction of that profile notifies', async () => {
    const store = await PGliteStore.open(await open());
    const profileId = '7c8a7f3e-2d4b-4e1a-9b3c-5d6e7f8a9b0c';
    let woke = false;
    const waiting = store.waitForEvent(profileId, new AbortController().signal).then(() => {
      woke = true;
    });
    await store.transaction(profileId, async (tx) => {
      await tx.execute(sql`select pg_notify('jian_events', ${profileId})`);
    });
    await waiting;
    expect(woke).toBe(true);
    await store.close();
  }, 60_000);

  it('refuses a query outside the open transaction, which would hang it, and keeps answering', async () => {
    const store = await PGliteStore.open(await open());
    const profileId = '7c8a7f3e-2d4b-4e1a-9b3c-5d6e7f8a9b0c';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.db.execute(sql`create table kept (value text)`);

    const stuck = store.transaction(profileId, async (tx) => {
      await tx.execute(sql`insert into kept values ('rolled back')`);
      await store.db.execute(sql`select 1`);
    });

    // Drizzle wraps what the client rejected with.
    await expect(stuck).rejects.toMatchObject({ cause: expect.any(QueryOutsideTransaction) });
    // The log names the transaction that was open, opened here.
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/was opened:\n[\s\S]*pglite-store\.test\.ts/);
    const rows = (await store.db.execute(sql`select value from kept`)) as unknown as {
      rows: unknown[];
    };
    expect(rows.rows).toEqual([]);

    // Started in the body and left running: it waits for the commit, then runs.
    let after: Promise<unknown> | undefined;
    await store.transaction(profileId, async (tx) => {
      await tx.execute(sql`insert into kept values ('kept')`);
      after = Promise.resolve().then(() =>
        new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
          store.db.execute(sql`select value from kept`),
        ),
      );
    });
    await expect(after).resolves.toMatchObject({ rows: [{ value: 'kept' }] });
    logged.mockRestore();
    await store.close();
  }, 60_000);
});

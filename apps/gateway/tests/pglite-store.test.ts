import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { PGliteStore } from '../src/storage/pglite.js';

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
});

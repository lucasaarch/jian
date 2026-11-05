import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { createGateway } from '../src/gateway.js';
import { SecretBox } from '../src/security/crypto.js';
import { remoteTasks } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

afterEach(() => vi.restoreAllMocks());

/** A gateway on the test database, with a machine and one files task of each age running. */
async function prepared(role: 'all' | 'api' | 'worker') {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const machine = await services.remote.create({ name: 'Studio' });
  const young = new Date(Date.now() - 5_000);
  const old = new Date(Date.now() - 10 * 60_000);
  const ids = {
    young: '00000000-0000-4000-8000-000000000021',
    old: '00000000-0000-4000-8000-000000000022',
  };
  for (const [id, at] of [
    [ids.young, young],
    [ids.old, old],
  ] as const) {
    await services.store.db.insert(remoteTasks).values({
      id,
      machineId: machine.id,
      profileId: profile.id,
      kind: 'files',
      command: '',
      payload: { op: 'read', path: '/srv/notes.txt', maxBytes: 1000 },
      timeoutMs: 60_000,
      status: 'running',
      createdAt: at,
      updatedAt: at,
    });
  }
  const gateway = await createGateway({
    store: services.store,
    box: new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
    token: 'synthetic-token-0000000000000000000000000000',
    role,
    channels: 'none',
    mode: 'server',
    allowPrivateOrigins: [],
    trustedProxies: [],
  });
  const status = async (id: string) =>
    (await services.store.db.select().from(remoteTasks).where(eq(remoteTasks.id, id)))[0]?.status;
  return { gateway, ids, status };
}

it('fails every files task left running when the only gateway process starts', async () => {
  const { gateway, ids, status } = await prepared('all');
  await gateway.start();
  try {
    expect(await status(ids.young)).toBe('failed');
    expect(await status(ids.old)).toBe('failed');
  } finally {
    await gateway.stop();
  }
});

it('leaves the calls another process may still wait on, sweeping again while it runs', async () => {
  const every = vi.spyOn(globalThis, 'setInterval');
  const clear = vi.spyOn(globalThis, 'clearInterval');
  const { gateway, ids, status } = await prepared('api');
  await gateway.start();
  const sweep = every.mock.results[every.mock.calls.findIndex(([, ms]) => ms === 60_000)]?.value;
  try {
    expect(await status(ids.young)).toBe('running');
    expect(await status(ids.old)).toBe('failed');
    expect(sweep).toBeDefined();
  } finally {
    await gateway.stop();
  }
  expect(clear).toHaveBeenCalledWith(sweep);
});

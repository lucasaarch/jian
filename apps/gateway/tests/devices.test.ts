import { expect, it } from 'vitest';
import { hashSecret } from '../src/devices/tokens.js';
import { devicePairings } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const URL_ = 'https://jian.example.test/';

async function paired(services: Awaited<ReturnType<typeof testServices>>, name = "Kai's iPhone") {
  const { code } = await services.devices.createPairing(URL_);
  return services.devices.pair({ code, name, platform: 'ios' });
}

it('pairs a phone once per code, and the code expires', async () => {
  let now = Date.parse('2026-11-06T12:00:00Z');
  const services = await testServices(() => now);
  const pairing = await services.devices.createPairing(URL_);
  expect(pairing.url).toBe('https://jian.example.test');

  const result = await services.devices.pair({
    code: pairing.code,
    name: "Kai's iPhone",
    platform: 'ios',
  });
  expect(result.token.startsWith('jdev_')).toBe(true);
  expect(result.device.push).toBe(false);
  await expect(
    services.devices.pair({ code: pairing.code, name: 'Again', platform: 'ios' }),
  ).rejects.toMatchObject({ statusCode: 401 });

  const late = await services.devices.createPairing(URL_);
  now += 5 * 60 * 1000 + 1;
  await expect(
    services.devices.pair({ code: late.code, name: 'Late', platform: 'android' }),
  ).rejects.toMatchObject({ statusCode: 401 });
});

it('counts a code down in seconds and prunes the codes that expired', async () => {
  let now = Date.parse('2026-11-06T12:00:00Z');
  const services = await testServices(() => now);
  const first = await services.devices.createPairing(URL_);
  expect(first.expiresIn).toBe(300);
  await services.devices.pair({ code: first.code, name: 'Spent', platform: 'ios' });
  await services.devices.createPairing(URL_);

  now += 5 * 60 * 1000 + 1;
  const fresh = await services.devices.createPairing(URL_);

  const left = await services.store.db.select().from(devicePairings);
  expect(left.map((row) => row.codeHash)).toEqual([hashSecret(fresh.code)]);
});

it('creates exactly one device when one code is sent twice at once', async () => {
  const services = await testServices();
  const { code } = await services.devices.createPairing(URL_);
  const input = { code, name: 'Phone', platform: 'android' };
  const results = await Promise.allSettled([
    services.devices.pair(input),
    services.devices.pair(input),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await services.devices.list()).toHaveLength(1);
});

it('refuses to pair without a public address', async () => {
  const services = await testServices();
  await expect(services.devices.createPairing(undefined)).rejects.toMatchObject({
    statusCode: 409,
  });
});

it('authenticates a device until it is revoked', async () => {
  const services = await testServices();
  const { device, token } = await paired(services);
  expect(await services.devices.authenticate(`Bearer ${token}`)).toBe(device.id);

  await services.devices.revoke(device.id);
  expect(await services.devices.authenticate(`Bearer ${token}`)).toBeUndefined();
  expect(await services.devices.authenticate('Bearer jdev_')).toBeUndefined();
  expect(await services.devices.authenticate(`Bearer ${'jdev_'.padEnd(600, 'a')}`)).toBeUndefined();
  expect(await services.devices.authenticate('Basic x')).toBeUndefined();
  await expect(services.devices.revoke(device.id)).rejects.toMatchObject({ statusCode: 404 });
});

it('writes last seen at most once a minute', async () => {
  let now = Date.parse('2026-11-06T12:00:00Z');
  const services = await testServices(() => now);
  const { device, token } = await paired(services);
  await services.devices.authenticate(`Bearer ${token}`);
  const first = (await services.devices.list())[0]?.lastSeenAt;
  now += 30_000;
  await services.devices.authenticate(`Bearer ${token}`);
  expect((await services.devices.list())[0]?.lastSeenAt).toBe(first);
  now += 30_000;
  await services.devices.authenticate(`Bearer ${token}`);
  expect((await services.devices.list())[0]?.lastSeenAt).not.toBe(first);
  expect(device.lastSeenAt).toBeNull();
});

it('keeps a push token on one device only', async () => {
  const services = await testServices();
  const a = (await paired(services, 'A')).device;
  const b = (await paired(services, 'B')).device;
  const pushToken = 'ExponentPushToken[synthetic]';
  await services.devices.setPush(a.id, { pushToken });
  await services.devices.setPush(b.id, { pushToken });

  expect((await services.devices.pushTargets()).map((t) => t.id)).toEqual([b.id]);
  const listed = await services.devices.list();
  expect(listed.find((d) => d.id === a.id)?.push).toBe(false);
});

it('never lists a token or hash', async () => {
  const services = await testServices();
  const { token } = await paired(services);
  const listed = JSON.stringify(await services.devices.list());
  expect(listed).not.toContain(token);
  expect(listed).not.toContain(hashSecret(token));
});

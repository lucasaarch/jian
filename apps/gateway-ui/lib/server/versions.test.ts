import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const gatewayAt = (version: string | undefined) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ status: 'ok', service: 'jian', ...(version ? { version } : {}) }),
    ),
  );

it('tells two releases apart, and never stands in the way of a local build', async () => {
  vi.stubEnv('JIAN_VERSION', '1.0.6');
  gatewayAt('1.0.5');
  const { versionMismatch } = await import('./versions');
  expect(await versionMismatch()).toEqual({ web: '1.0.6', gateway: '1.0.5' });

  vi.resetModules();
  gatewayAt('1.0.6');
  expect(await (await import('./versions')).versionMismatch()).toBeUndefined();

  // A gateway built from source names no version; a panel built from source has none either.
  vi.resetModules();
  gatewayAt(undefined);
  expect(await (await import('./versions')).versionMismatch()).toBeUndefined();
  vi.resetModules();
  vi.stubEnv('JIAN_VERSION', '0.0.0-dev');
  gatewayAt('1.0.5');
  expect(await (await import('./versions')).versionMismatch()).toBeUndefined();
});

it('lets the panel through when the gateway cannot say which release it is', async () => {
  vi.stubEnv('JIAN_VERSION', '1.0.6');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }),
  );
  const { versionMismatch } = await import('./versions');
  expect(await versionMismatch()).toBeUndefined();
});

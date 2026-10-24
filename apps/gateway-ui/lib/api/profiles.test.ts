import { afterEach, expect, it, vi } from 'vitest';
import { gatewayApi } from '.';

afterEach(() => vi.unstubAllGlobals());

const legacy = {
  status: 'legacy_unclassified',
  assignable: false,
  scope: 'configuration',
  profession: null,
  ceilingCapabilities: null,
  configurationEffectiveCapabilities: null,
};

it('keeps explicit unresolved legacy fields from the authenticated descriptor response', async () => {
  const fetch = vi.fn(async () => Response.json(legacy));
  vi.stubGlobal('fetch', fetch);
  expect(await gatewayApi().profileProfession('profile')).toEqual(legacy);
  const [request] = fetch.mock.calls[0] as unknown as [Request];
  expect(request.url).toBe(`${window.location.origin}/v1/profiles/profile/profession`);
  expect(request.method).toBe('GET');
  expect(request.headers.get('x-jian-panel')).toBe('1');
});

it('rejects inconsistent or assignment-enabled descriptors rather than inventing defaults', async () => {
  for (const descriptor of [
    { ...legacy, assignable: true },
    { ...legacy, ceilingCapabilities: [] },
    { status: 'legacy_unclassified', assignable: false, scope: 'configuration' },
  ]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(descriptor)),
    );
    await expect(gatewayApi().profileProfession('profile')).rejects.toThrow();
  }
});

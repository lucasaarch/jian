import { afterEach, expect, it, vi } from 'vitest';
import { gatewayApi } from '.';

afterEach(() => vi.unstubAllGlobals());

it('patches only chat AI using the authenticated panel client', async () => {
  const fetch = vi.fn(async () => Response.json({ id: 'contact', aiEnabled: false }));
  vi.stubGlobal('fetch', fetch);
  await gatewayApi().updateContact('profile', 'contact', { aiEnabled: false });
  const [request, init] = fetch.mock.calls[0] as unknown as [Request, RequestInit];
  expect(request.url).toBe(`${window.location.origin}/v1/profiles/profile/contacts/contact`);
  expect(request.method).toBe('PATCH');
  expect(request.headers.get('x-jian-panel')).toBe('1');
  expect(init.credentials).toBe('same-origin');
  expect(await request.json()).toEqual({ aiEnabled: false });
});

it('reports host authorization errors instead of claiming a chat was paused', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'Forbidden' }, { status: 403 })),
  );
  await expect(
    gatewayApi().updateContact('profile', 'contact', { aiEnabled: false }),
  ).rejects.toThrow('This action needs the host token.');
});

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

it('marks a contact as one who may approve actions, and nothing else', async () => {
  const fetch = vi.fn(async () => Response.json({ id: 'contact', canApprove: true }));
  vi.stubGlobal('fetch', fetch);
  await gatewayApi().updateContact('profile', 'contact', { canApprove: true });
  const [request] = fetch.mock.calls[0] as unknown as [Request];
  expect(request.method).toBe('PATCH');
  expect(await request.json()).toEqual({ canApprove: true });
});

it('sends each approval decision with a key of its own, so a retry is not a second decision', async () => {
  const fetch = vi.fn(async () => Response.json({ id: 'run' }, { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  await gatewayApi().decideApproval('profile', 'run', 'approve');
  await gatewayApi().decideApproval('profile', 'run', 'approve');
  const bodies = await Promise.all(
    (fetch.mock.calls as unknown as [Request][]).map(([request]) => {
      expect(request.url).toBe(`${window.location.origin}/v1/profiles/profile/runs/run/approval`);
      return request.json() as Promise<{ decision: string; requestKey: string }>;
    }),
  );
  expect(bodies.map((body) => body.decision)).toEqual(['approve', 'approve']);
  expect(bodies[0]?.requestKey).toBeTruthy();
  expect(bodies[0]?.requestKey).not.toBe(bodies[1]?.requestKey);
});

it('sets a conversation to full access through its protection', async () => {
  const fetch = vi.fn(async () => Response.json({ id: 'session', protection: 'full' }));
  vi.stubGlobal('fetch', fetch);
  await gatewayApi().setSessionProtection('profile', 'session', 'full');
  const [request] = fetch.mock.calls[0] as unknown as [Request];
  expect(request.method).toBe('PUT');
  expect(request.url).toBe(
    `${window.location.origin}/v1/profiles/profile/sessions/session/protection`,
  );
  expect(await request.json()).toEqual({ protection: 'full' });
});

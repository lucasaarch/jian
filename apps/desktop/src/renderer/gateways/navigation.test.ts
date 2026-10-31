import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@jian/ui', async () => {
  const source = new URL('../../../../../packages/ui/src/platform/navigation.tsx', import.meta.url)
    .href;
  const { createMemoryNavigation } = await import(source);
  return { createMemoryNavigation, newChatPath: (id: string) => `/agents/${id}?new` };
});

const saved = new Map<string, string>();
beforeEach(() => {
  vi.resetModules();
  saved.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it('restores each gateway at its conversation or view after the renderer reloads', async () => {
  const { openIn, navigationFor } = await import('./navigation');
  openIn('local', '/agents/nova/sessions/chat');
  openIn('remote', '/agents/mia/overview?tab=activity');
  const local = navigationFor('local');
  local.navigation(local.current()).push('/agents/nova/schedules');
  local.back();
  vi.resetModules();
  const reloaded = await import('./navigation');
  expect(reloaded.navigationFor('local').current()).toBe('/agents/nova/sessions/chat');
  expect(reloaded.navigationFor('remote').current()).toBe('/agents/mia/overview?tab=activity');
});

it('keeps the last view when connectivity redirects to sign-in and clears forgotten gateways', async () => {
  const { openIn, forget } = await import('./navigation');
  openIn('local', '/agents/nova/sessions/chat');
  openIn('local', '/sign-in');
  vi.resetModules();
  const reloaded = await import('./navigation');
  expect(reloaded.navigationFor('local').current()).toBe('/agents/nova/sessions/chat');
  forget('local');
  vi.resetModules();
  const forgotten = await import('./navigation');
  expect(forgotten.navigationFor('local').current()).toBe('/');
});

it('continues navigating when storage is unavailable', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('Unavailable');
    },
    setItem: () => {
      throw new Error('Unavailable');
    },
    removeItem: () => {
      throw new Error('Unavailable');
    },
  });
  const { openIn, navigationFor, forget } = await import('./navigation');
  openIn('local', '/agents/nova/overview');
  expect(navigationFor('local').current()).toBe('/agents/nova/overview');
  expect(() => forget('local')).not.toThrow();
});

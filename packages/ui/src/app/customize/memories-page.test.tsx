import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Memory } from '../../lib/api';
import { AgentCache } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { MemoriesPage } from './memories-page';

const actions = vi.hoisted(() => ({ api: {} as GatewayApi }));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({
    api: actions.api,
    mutate: (action: () => Promise<unknown>) =>
      action().then(
        () => true,
        () => false,
      ),
    busy: false,
  }),
}));

const memory = (key: string, content: string) =>
  ({
    key,
    content,
    version: 2,
    links: [],
    updatedAt: '2026-09-20T10:00:00Z',
  }) as unknown as Memory;

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

it('forgets a memory only once the owner confirms it', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const forget = vi.fn(async () => ({}));
  actions.api = { forget } as unknown as GatewayApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache
        profile={profile}
        slices={{
          memories: [
            memory('harbor-trip', 'The owner sails from Port Alder every second Saturday.'),
            memory('tea', 'Prefers green tea, no sugar.'),
          ],
        }}
      >
        <MemoriesPage />
      </AgentCache>,
    ),
  );
  const button = (name: string) =>
    [...document.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    );

  await act(async () => button('Configure harbor-trip')?.click());
  await act(async () => button('Forget')?.click());
  const confirm = button('Forget memory') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);
  expect(forget).not.toHaveBeenCalled();

  const field = confirm?.closest('form')?.querySelector('input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      field,
      'forget',
    );
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => confirm?.click());

  expect(forget).toHaveBeenCalledWith(profile.id, 'harbor-trip');
});

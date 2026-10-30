import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, SshKey } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { SshKeysPage } from './ssh-keys-page';

const actions = vi.hoisted(() => ({ api: {} as GatewayApi }));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({
    api: actions.api,
    // As the panel's own: false when the action failed.
    mutate: (action: () => Promise<unknown>) =>
      action().then(
        () => true,
        () => false,
      ),
    busy: false,
  }),
}));

const key = {
  id: '3f1d2c4b-5a69-4e7f-8a0b-1c2d3e4f5a6b',
  name: 'Harbor Git',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISyntheticKeyMaterialOnly harbor-git',
  fingerprint: 'SHA256:syntheticfingerprint',
  createdAt: '2026-10-29T12:00:00Z',
} as SshKey;

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

it('deletes a key only once its name is typed, and drops it from the list', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const deleteSshKey = vi.fn(async () => undefined);
  actions.api = { sshKeys: async () => [key], deleteSshKey } as unknown as GatewayApi;
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  client.setQueryData(keys.sshKeys, [key]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SshKeysPage />
      </QueryClientProvider>,
    ),
  );
  const button = (name: string) =>
    [...document.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    );

  await act(async () => button('Delete Harbor Git')?.click());
  const confirm = button('Delete key');
  expect(confirm?.disabled).toBe(true);
  const input = document.querySelector<HTMLInputElement>('form input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'Harbor Git',
    );
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => confirm?.click());

  expect(deleteSshKey).toHaveBeenCalledWith(key.id);
  expect(host.textContent).not.toContain('Harbor Git');
});

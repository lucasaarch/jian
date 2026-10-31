import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Session } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { SessionProtection } from './protection-menu';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

const pick = async (label: string) => {
  await act(async () => element.querySelector<HTMLButtonElement>('button')?.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('.model-option')].find((item) =>
    item.textContent?.startsWith(label),
  );
  await act(async () => option?.click());
};

it('asks first until changed, and saves full access for the conversation', async () => {
  const setSessionProtection = vi.fn(async () => ({}));
  const session = { id: 'session', protection: 'ask' } as Session;
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionProtection
          api={{ setSessionProtection } as unknown as GatewayApi}
          profileId="profile"
          session={session}
        />
      </QueryClientProvider>,
    ),
  );

  expect(element.textContent).toContain('Ask first');
  await pick('Full access');
  expect(setSessionProtection).toHaveBeenCalledWith('profile', 'session', 'full');
  expect(element.textContent).toContain('Full access');
});

it('keeps a new chat’s choice until the conversation exists', async () => {
  const setSessionProtection = vi.fn();
  const onDraftChange = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionProtection
          api={{ setSessionProtection } as unknown as GatewayApi}
          profileId="profile"
          draft="ask"
          onDraftChange={onDraftChange}
        />
      </QueryClientProvider>,
    ),
  );

  await pick('Full access');
  expect(onDraftChange).toHaveBeenCalledWith('full');
  expect(setSessionProtection).not.toHaveBeenCalled();
});

for (const [where, props, saved] of [
  ['a new chat', { draft: 'ask', onDraftChange: () => {} }, undefined],
  ['a conversation', { session: { id: 'session', protection: 'ask' } as Session }, 'full'],
] as const) {
  it(`makes a pick in ${where}'s composer where the next new chat starts`, async () => {
    const updateSettings = vi.fn(async () => ({}));
    const setSessionProtection = vi.fn(async () => ({}));
    const client = new QueryClient();
    client.setQueryData(keys.settings, { newChatProtection: 'ask' });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SessionProtection
            api={{ setSessionProtection, updateSettings } as unknown as GatewayApi}
            profileId="profile"
            remembers
            {...props}
          />
        </QueryClientProvider>,
      ),
    );

    await pick('Full access');

    expect(updateSettings).toHaveBeenCalledWith({ newChatProtection: 'full' });
    expect(client.getQueryData(keys.settings)).toEqual({ newChatProtection: 'full' });
    if (saved) expect(setSessionProtection).toHaveBeenCalledWith('profile', 'session', saved);
  });
}

it('leaves the preference alone when the conversation could not change', async () => {
  const updateSettings = vi.fn(async () => ({}));
  const setSessionProtection = vi.fn(async () => {
    throw new Error('Offline');
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionProtection
          api={{ setSessionProtection, updateSettings } as unknown as GatewayApi}
          profileId="profile"
          session={{ id: 'session', protection: 'ask' } as Session}
          remembers
        />
      </QueryClientProvider>,
    ),
  );

  await pick('Full access');

  expect(updateSettings).not.toHaveBeenCalled();
});

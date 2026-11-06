import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppSettings } from './app-settings';

vi.mock('../lib/query/client', () => ({
  panelApi: () => ({
    settings: async () => ({}),
    repository: async () => ({ stars: 1 }),
    releaseNotes: async () => [],
  }),
}));
vi.mock('./release-notes', () => ({ ReleaseNotesRow: () => null }));

let root: Root | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function show(local: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <AppSettings
          open
          onOpenChange={() => {}}
          host={{ version: '1.6.0' }}
          gateway={{
            info: {
              id: 'g1',
              name: 'Harbor',
              local,
              url: 'http://127.0.0.1:4310',
              state: 'Connected',
            },
          }}
        />
      </QueryClientProvider>,
    ),
  );
}

const offered = (label: string) => document.body.textContent?.includes(label) ?? false;

it('offers Mobile on a server gateway', async () => {
  await show(false);
  expect(offered('Mobile')).toBe(true);
});

it("does not offer Mobile on this computer's own gateway", async () => {
  await show(true);
  expect(offered('Providers')).toBe(true);
  expect(offered('Mobile')).toBe(false);
});

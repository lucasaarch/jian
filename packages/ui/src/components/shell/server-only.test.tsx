import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../../lib/query/keys';
import { goTo } from '../../test/route';
import { Sidebar } from './sidebar';

/** The sidebar on a gateway that says it is `mode`, with nothing else behind it. */
async function sidebarOn(mode: 'server' | 'local') {
  const cache = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  cache.setQueryData(keys.gateway, { status: 'ok', service: 'jian', mode });
  cache.setQueryData(keys.profiles, []);
  cache.setQueryData(keys.releases, { version: '1.0.0', notes: [], unseen: [], behind: 0 });
  goTo('/');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={cache}>
        <Sidebar open={false} onNavigate={() => {}} onCreateProfile={() => {}} />
      </QueryClientProvider>,
    );
  });
  const labels = [...host.querySelectorAll('nav a')].map((link) => link.textContent?.trim());
  act(() => root.unmount());
  host.remove();
  return labels;
}

describe('the sections a gateway has', () => {
  // What the sidebar reads besides the sections (the repository's stars) has no gateway here.
  beforeEach(() => vi.stubGlobal('fetch', async () => Response.json({})));
  afterEach(() => vi.unstubAllGlobals());

  it('leaves out channels and remote control on a desktop app’s own gateway', async () => {
    const labels = await sidebarOn('local');
    expect(labels).not.toContain('Channels');
    expect(labels).not.toContain('Remote Control');
    expect(labels).toContain('Chats');
  });

  it('shows them on a server', async () => {
    const labels = await sidebarOn('server');
    expect(labels).toContain('Channels');
    expect(labels).toContain('Remote Control');
  });
});

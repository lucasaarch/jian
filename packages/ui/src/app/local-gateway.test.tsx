import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { keys } from '../lib/query/keys';
import { useAgentOverlay } from '../lib/stores/agent-overlay';
import { memoryNavigation } from '../platform/navigation';
import { AgentCache, agentClient } from '../test/agent';
import { profile } from '../test/fixtures';
import { AgentOverlays } from './agent-overlays';
import { AppSettings } from './app-settings';

// What each page lists is its own test's; here only which pages a gateway has.
vi.mock('./customize/skills-page', () => ({
  SkillsPage: () => <p>Skills</p>,
  SkillsWaiting: () => null,
}));
vi.mock('./customize/channels-page', () => ({
  ChannelsPage: () => <p>Channels</p>,
  ChannelsWaiting: () => null,
}));

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(ui: React.ReactNode, mode: 'local' | 'server') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = agentClient({ profile, slices: { contacts: [], sessions: [] } });
  client.setQueryData(keys.gateway, { status: 'ok', version: '1.4.0', mode });
  // On its chats: the agent's bare address would ask for its Activity.
  memoryNavigation.go(`/agents/${profile.id}/sessions`);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache client={client} profile={profile}>
        {ui}
      </AgentCache>,
    ),
  );
  return host;
}

const labels = (selector: string) =>
  [...document.querySelectorAll(selector)].map((item) => item.textContent?.trim());

for (const mode of ['local', 'server'] as const) {
  it(`offers channels in the agent's settings only on a server (${mode})`, async () => {
    useAgentOverlay.getState().openSettings('channels');
    await render(<AgentOverlays profileId={profile.id} />, mode);
    const dialog = document.querySelector('[data-app-page]');

    if (mode === 'server') {
      expect(labels('nav button')).toContain('Channels');
      expect(dialog?.querySelector('section h1')?.textContent).toBe('Channels');
    } else {
      // Asked for by name, it lands on Identity on this computer's gateway, which has none.
      expect(labels('nav button')).not.toContain('Channels');
      expect(dialog?.querySelector('section h1')?.textContent).toBe('Identity');
    }
    act(() => useAgentOverlay.getState().closeSettings());
  });

  it(`lists machines in Settings only on a server (${mode})`, async () => {
    await render(
      <AppSettings
        open
        onOpenChange={() => {}}
        host={{ version: '1.4.0' }}
        gateway={{
          info: { id: 'g', name: 'Gateway', local: mode === 'local', url: '', state: 'Connected' },
        }}
      />,
      mode,
    );

    const pages = labels('nav[aria-label="Settings"] button');
    expect(pages.includes('Machines')).toBe(mode === 'server');
    // Served by its own gateway, the web keeps no connection of its own to show.
    expect(pages).not.toContain('Connection');
  });
}

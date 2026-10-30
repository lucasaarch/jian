import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { keys } from '../lib/query/keys';
import { AgentCache, agentClient } from '../test/agent';
import { profile } from '../test/fixtures';
import { CustomizeView } from './agent-pages';
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
  const client = agentClient({ profile });
  client.setQueryData(keys.gateway, { status: 'ok', version: '1.4.0', mode });
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
  it(`offers channels in Customize only on a server (${mode})`, async () => {
    const host = await render(<CustomizeView profileId={profile.id} tab="channels" />, mode);

    if (mode === 'server') {
      expect(labels('[aria-label="Customize"] button')).toContain('Channels');
      expect(host.textContent).toContain('Channels');
    } else {
      // An address that names Channels lands on Skills on this computer's gateway.
      expect(labels('[aria-label="Customize"] button')).not.toContain('Channels');
      expect(host.textContent).toContain('Skills');
    }
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

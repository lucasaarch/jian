import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsGroup } from '../kit';
import { ReleaseNotes, ReleaseNotesRow } from './release-notes';

const note = {
  version: '2.2.0',
  date: '2026-09-24',
  summary: 'Agents search the web.',
  body: '## Web\n\n- **Search** with `web_search`\n- Read [pages](https://example.com)\n\n<img src=x onerror=alert(1)>',
  prerelease: false,
};
const older = {
  version: '2.1.0',
  date: '2026-09-23',
  summary: 'Precise code edits.',
  body: '- **agent:** edit code precisely',
  prerelease: false,
};

const gateway = vi.hoisted(() => ({
  releases: vi.fn(),
  markReleasesSeen: vi.fn(async () => ({})),
}));
vi.mock('../lib/query/client', () => ({ panelApi: () => gateway }));

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
  gateway.markReleasesSeen.mockClear();
});

async function render(ui: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  gateway.releases.mockResolvedValue({
    version: '2.2.0',
    behind: 0,
    notes: [note, older],
    updates: [],
    unseen: [note],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>),
  );
  // The cache tells its readers on the next tick, not within the one that answered.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);

it('shows what changed once, as text, and marks it read on close', async () => {
  await render(<ReleaseNotes />);

  expect(dialog()?.querySelector('h2')?.textContent).toBe("What's new in Jian 2.2.0");
  expect(dialog()?.textContent).toContain('Agents search the web.');
  expect(dialog()?.querySelector('li strong')?.textContent).toBe('Search');
  expect(dialog()?.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  // Markup in a note is shown as text, never run.
  expect(dialog()?.querySelector('img')).toBeNull();

  await act(async () => button('Got it')?.click());

  expect(gateway.markReleasesSeen).toHaveBeenCalledOnce();
});

it('opens every release from Settings, newest first, and marks nothing read', async () => {
  await render(
    <SettingsGroup>
      <ReleaseNotesRow />
    </SettingsGroup>,
  );

  await act(async () => button('Read')?.click());

  expect(dialog()?.querySelector('h2')?.textContent).toBe('Release notes');
  expect(
    [...(dialog()?.querySelectorAll('section[aria-label]') ?? [])].map((item) =>
      item.getAttribute('aria-label'),
    ),
  ).toEqual(['Jian 2.2.0', 'Jian 2.1.0']);
  await act(async () => button('Close')?.click());

  expect(gateway.markReleasesSeen).not.toHaveBeenCalled();
});

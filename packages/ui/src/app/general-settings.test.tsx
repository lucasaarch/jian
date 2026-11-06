import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GeneralSettings } from './general-settings';

const api = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
  repository: vi.fn(async () => ({ stars: 3 })),
  releaseNotes: vi.fn(async () => []),
}));
vi.mock('../lib/query/client', () => ({ panelApi: () => api }));
vi.mock('./release-notes', () => ({ ReleaseNotesRow: () => null }));

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.settings.mockReset();
  api.updateSettings.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <GeneralSettings host={{ version: '1.6.0' }} gateway />
      </QueryClientProvider>,
    ),
  );
}

const zone = { timeZone: 'UTC', timeZoneSource: 'host' as const };
const switchOf = () => host.querySelector<HTMLElement>('[role="switch"]');

it('shares anonymous usage data until the owner turns it off', async () => {
  api.settings.mockResolvedValue({ ...zone, telemetry: { enabled: true, source: 'default' } });
  api.updateSettings.mockResolvedValue({
    ...zone,
    telemetry: { enabled: false, source: 'setting' },
  });

  await show();
  const toggle = await vi.waitFor(() => {
    const found = switchOf();
    if (!found) throw new Error('no switch');
    return found;
  });
  expect(host.textContent).toContain('Share anonymous usage data');
  expect(toggle.getAttribute('aria-checked')).toBe('true');

  await act(async () => toggle.click());

  expect(api.updateSettings).toHaveBeenCalledWith({ telemetry: false });
  await vi.waitFor(() => expect(switchOf()?.getAttribute('aria-checked')).toBe('false'));
});

it("says it is off when the gateway's host turned it off, with nothing to switch", async () => {
  api.settings.mockResolvedValue({ ...zone, telemetry: { enabled: false, source: 'environment' } });

  await show();

  await vi.waitFor(() => expect(host.textContent).toContain('DO_NOT_TRACK'));
  expect(switchOf()).toBeNull();
});

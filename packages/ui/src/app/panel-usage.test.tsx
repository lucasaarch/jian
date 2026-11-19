import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCrew } from '../lib/stores/crew';
import { setUsageReporting } from '../lib/usage';
import { usePanelUsage } from './panel-usage';

const api = vi.hoisted(() => ({
  settings: vi.fn(),
  reportPanelUsage: vi.fn(async () => undefined),
}));
vi.mock('../lib/query/client', () => ({ panelApi: () => api }));

let root: Root | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  setUsageReporting(false);
  setUsageReporting(undefined);
  api.reportPanelUsage.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

function Panel() {
  usePanelUsage();
  return null;
}

async function open(enabled: boolean) {
  api.settings.mockResolvedValue({
    timeZone: 'UTC',
    timeZoneSource: 'host',
    telemetry: { enabled, source: enabled ? 'default' : 'setting' },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <Panel />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
}

const leave = () => act(async () => window.dispatchEvent(new Event('pagehide')));

it('hands what the panel counted to its gateway as the page goes', async () => {
  await open(true);
  await act(async () => {
    useCrew.getState().show('conversation-1', []);
    useCrew.getState().showFiles();
  });

  await leave();

  expect(api.reportPanelUsage).toHaveBeenCalledTimes(1);
  expect(api.reportPanelUsage).toHaveBeenCalledWith(
    {
      host: 'web',
      phone: false,
      counts: { panel_opened: 1, theme_dark: 1, inspector_opened: 1, inspector_files: 1 },
    },
    true,
  );
});

it('counts and sends nothing while the gateway keeps its report off', async () => {
  await open(false);
  await act(async () => {
    useCrew.getState().show('conversation-2', []);
    useCrew.getState().showFiles();
  });

  await leave();

  expect(api.reportPanelUsage).not.toHaveBeenCalled();
});

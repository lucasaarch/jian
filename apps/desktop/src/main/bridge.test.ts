import { beforeEach, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  return {
    listeners,
    windowClosed: vi.fn(async () => undefined),
    ipcMain: {
      on: (channel: string, listener: (...args: unknown[]) => unknown) =>
        listeners.set(channel, listener),
      handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
        listeners.set(channel, listener),
    },
  };
});
const monitorClosed = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('electron', () => ({
  app: { getVersion: () => '1.8.0' },
  dialog: {},
  shell: {},
  ipcMain: electron.ipcMain,
  session: { defaultSession: { closeAllConnections: electron.windowClosed } },
}));
vi.mock('./gateways/fetch', () => ({ closeMonitorConnections: monitorClosed }));
vi.mock('./gateways/store', () => ({ VAULT_MISSING: 'missing', vaultAvailable: async () => true }));
vi.mock('./gateways/verify', () => ({ verify: vi.fn() }));
vi.mock('./local/log', () => ({ localLogPath: () => '/tmp/jian-test.log' }));
vi.mock('./preferences', () => ({ notificationsOn: () => true, setNotifications: vi.fn() }));

import { serveBridge } from './bridge';

beforeEach(() => {
  electron.windowClosed.mockClear();
  monitorClosed.mockClear();
});

it('closes the window’s connections and the monitor’s before it looks at a gateway away', async () => {
  const refresh = vi.fn();
  const monitor = {
    summaries: () => [{ id: 'harbor', status: 'offline' }],
    refresh,
  };
  serveBridge({ monitor, window: () => undefined } as never);

  electron.listeners.get('gateways:reconnect')?.({}, 'harbor');
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith('harbor'));

  expect(electron.windowClosed).toHaveBeenCalledTimes(1);
  expect(monitorClosed).toHaveBeenCalledTimes(1);
});

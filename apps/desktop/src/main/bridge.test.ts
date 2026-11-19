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

const store = { get: () => ({ url: 'https://harbor.example.test' }) };

it.each(['offline', 'online'])(
  'closes the window’s connections and the monitor’s before it looks at a gateway %s',
  async (status) => {
    const refresh = vi.fn();
    const monitor = {
      summaries: () => [{ id: 'harbor', status }],
      refresh,
    };
    serveBridge({ store, monitor, window: () => undefined } as never);

    // The window's stream can be dead while the monitor still hears the gateway: an online
    // gateway's connections are closed too, and the window is answered only once they are.
    await electron.listeners.get('gateways:reconnect')?.({}, 'harbor');

    expect(electron.windowClosed).toHaveBeenCalledTimes(1);
    expect(monitorClosed).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('harbor');
  },
);

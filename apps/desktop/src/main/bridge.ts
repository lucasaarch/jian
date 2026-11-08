import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
  session,
  shell,
} from 'electron';
import type {
  AddGatewayResult,
  MachineUse,
  NewGateway,
  OpenTarget,
  Showing,
} from '../shared/bridge';
import { LOCAL_GATEWAY_ID } from '../shared/bridge';
import { closeMonitorConnections } from './gateways/fetch';
import type { GatewayMonitor } from './gateways/monitor';
import { parseGatewayUrl } from './gateways/rules';
import { type GatewayStore, VAULT_MISSING, vaultAvailable } from './gateways/store';
import { verify } from './gateways/verify';
import { localLogPath } from './local/log';
import type { ComputerSharing } from './machines/sharing';
import { notificationsOn, setNotifications } from './preferences';
import { showingFrom } from './showing';

/** The calls the window may make; each one checks what it is given, as from any other caller. */
export function serveBridge(deps: {
  store: GatewayStore;
  monitor: GatewayMonitor;
  machines: ComputerSharing;
  /** What agents are doing on this computer now. */
  using: () => MachineUse[];
  window: () => BrowserWindow | undefined;
  showing: (place: Showing | null) => void;
  /** The owner turned notifications on or off in the settings. */
  notificationsChanged: (on: boolean) => void;
  /** A gateway was added or removed: whatever lists them, besides the window, follows. */
  listChanged: () => void;
  /** Starts the app's own gateway again now, after it could not start. */
  retryLocal: () => void;
  /** Restarts the app's own gateway, including a process that stopped answering. */
  restartLocal: () => Promise<void>;
}): {
  changed(): void;
  machinesChanged(): void;
  machinesUsing(uses: MachineUse[]): void;
  open(target: OpenTarget): void;
} {
  const { store, monitor, machines } = deps;
  const send = (channel: string, value: unknown) => deps.window()?.webContents.send(channel, value);

  // Read once, as the preload starts: the window knows its own release before it draws.
  ipcMain.on('app:version', (event) => {
    event.returnValue = app.getVersion();
  });
  ipcMain.handle('gateways:list', () => monitor.summaries());
  ipcMain.on('local:retry', () => deps.retryLocal());
  ipcMain.on('gateways:reconnect', (_event, id: unknown) => {
    if (typeof id !== 'string') return;
    if (id === LOCAL_GATEWAY_ID) deps.retryLocal();
    const away = monitor.summaries().some((item) => item.id === id && item.status === 'offline');
    if (!away) {
      monitor.refresh(id);
      return;
    }
    // Every request of the window to a host shares one HTTP/2 connection, and every look of the
    // monitor shares another, of its own session: a stuck one would answer this look as it
    // answered the last. Only a restart used to clear it. This closes all of the app's
    // connections, both sessions' and other gateways' included; their event streams reopen and
    // resume by themselves, and a look cut off by it is not taken for the gateway's answer.
    // The monitor's session also carries the machine registry's and a new gateway's checks:
    // one of those under way is cut too, and fails as a request whose connection dropped.
    void Promise.allSettled([
      session.defaultSession.closeAllConnections(),
      closeMonitorConnections(),
    ]).finally(() => monitor.refresh(id));
  });
  ipcMain.handle('local:restart', () => deps.restartLocal());
  ipcMain.handle('dialog:pickFolder', async () => {
    const window = deps.window();
    const options = { properties: ['openDirectory', 'createDirectory'] } as OpenDialogOptions;
    const picked = await (window
      ? dialog.showOpenDialog(window, options)
      : dialog.showOpenDialog(options));
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  });
  // The folder, with the file chosen in it: the owner can open it, or send it on.
  ipcMain.on('local:openLog', () => shell.showItemInFolder(localLogPath()));

  ipcMain.handle('gateways:add', async (_event, input: NewGateway): Promise<AddGatewayResult> => {
    if (!(await vaultAvailable())) return { ok: false, error: VAULT_MISSING };
    const token = String(input?.token ?? '').trim();
    const parsed = parseGatewayUrl(String(input?.url ?? ''));
    if ('error' in parsed) return { ok: false, error: parsed.error };
    if (!token) return { ok: false, error: 'Enter the gateway’s host token.' };
    if (store.list().some((gateway) => gateway.url === parsed.url)) {
      return { ok: false, error: 'This gateway is already in the app.' };
    }
    const checked = await verify(parsed.url, token, app.getVersion());
    if (!checked.ok) return checked;
    const gateway = await store.add({
      url: parsed.url,
      token,
    });
    monitor.watch(gateway);
    const summary = monitor.summaries().find((item) => item.id === gateway.id);
    send('gateways:changed', monitor.summaries());
    deps.listChanged();
    return summary
      ? { ok: true, gateway: summary }
      : { ok: false, error: 'The gateway was not saved.' };
  });

  ipcMain.handle('gateways:remove', async (_event, id: string) => {
    if (store.get(id)?.local) return;
    monitor.forget(id);
    await machines.forget(id);
    await store.remove(id);
    send('gateways:changed', monitor.summaries());
    deps.listChanged();
  });

  ipcMain.handle('gateways:replaceToken', async (_event, id: string, token: string) => {
    const gateway = store.get(id);
    const trimmed = String(token ?? '').trim();
    if (!gateway || gateway.local) {
      return { ok: false, error: 'This gateway was removed from the app.' };
    }
    if (!trimmed) return { ok: false, error: 'Enter the gateway’s host token.' };
    const checked = await verify(gateway.url, trimmed, app.getVersion());
    if (!checked.ok) return checked;
    await store.replaceToken(id, trimmed);
    monitor.watch(gateway);
    return { ok: true };
  });

  let shown: string | undefined;
  ipcMain.on('gateways:showing', (_event, place: unknown) => {
    const read = showingFrom(place);
    deps.showing(read && store.get(read.gatewayId) ? read : null);
    // Turning to a gateway reads it at once; moving between its chats asks nothing of it.
    if (read && read.gatewayId !== shown) monitor.refresh(read.gatewayId);
    shown = read?.gatewayId;
  });

  ipcMain.on('window:minimize', () => deps.window()?.minimize());
  ipcMain.on('window:toggleMaximize', () => {
    const window = deps.window();
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  });
  // Closing hides the window into the tray, as the system's own close button would.
  ipcMain.on('window:close', () => deps.window()?.close());

  ipcMain.handle('settings:openAtLogin', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('settings:setOpenAtLogin', (_event, open: boolean) => {
    app.setLoginItemSettings({ openAtLogin: open === true });
  });
  ipcMain.handle('settings:notifications', () => notificationsOn());
  ipcMain.handle('settings:setNotifications', async (_event, on: boolean) => {
    await setNotifications(on === true);
    deps.notificationsChanged(on === true);
  });

  ipcMain.handle('machines:state', (_event, gatewayId: string) =>
    machines.state(String(gatewayId ?? '')),
  );
  ipcMain.handle('machines:using', () => deps.using());

  return {
    changed: () => send('gateways:changed', monitor.summaries()),
    machinesChanged: () => send('machines:changed', null),
    machinesUsing: (uses) => send('machines:using', uses),
    open: (target) => send('window:open', target),
  };
}

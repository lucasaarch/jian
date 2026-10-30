import { app, type BrowserWindow, ipcMain } from 'electron';
import type { AddGatewayResult, NewGateway, OpenTarget } from '../shared/bridge';
import type { GatewayMonitor } from './gateways/monitor';
import { parseGatewayUrl } from './gateways/rules';
import { type GatewayStore, VAULT_MISSING, vaultAvailable } from './gateways/store';
import { verify } from './gateways/verify';
import { checkNow } from './updates';

/** The calls the window may make; each one checks what it is given, as from any other caller. */
export function serveBridge(deps: {
  store: GatewayStore;
  monitor: GatewayMonitor;
  window: () => BrowserWindow | undefined;
  showing: (gatewayId: string | null) => void;
}): { changed(): void; open(target: OpenTarget): void } {
  const { store, monitor } = deps;
  const send = (channel: string, value: unknown) => deps.window()?.webContents.send(channel, value);

  // Read once, as the preload starts: the window knows its own release before it draws.
  ipcMain.on('app:version', (event) => {
    event.returnValue = app.getVersion();
  });
  ipcMain.handle('gateways:list', () => monitor.summaries());

  ipcMain.handle('gateways:add', async (_event, input: NewGateway): Promise<AddGatewayResult> => {
    if (!(await vaultAvailable())) return { ok: false, error: VAULT_MISSING };
    const name = String(input?.name ?? '')
      .trim()
      .slice(0, 60);
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
      name: name || new URL(parsed.url).host,
      url: parsed.url,
      token,
    });
    monitor.watch(gateway);
    const summary = monitor.summaries().find((item) => item.id === gateway.id);
    send('gateways:changed', monitor.summaries());
    return summary
      ? { ok: true, gateway: summary }
      : { ok: false, error: 'The gateway was not saved.' };
  });

  ipcMain.handle('gateways:rename', async (_event, id: string, name: string) => {
    const trimmed = String(name ?? '')
      .trim()
      .slice(0, 60);
    // The app's own gateway keeps its name, as it cannot be removed either.
    if (!store.get(id) || store.get(id)?.local || !trimmed) return;
    await store.rename(id, trimmed);
    send('gateways:changed', monitor.summaries());
  });

  ipcMain.handle('gateways:remove', async (_event, id: string) => {
    if (store.get(id)?.local) return;
    monitor.forget(id);
    await store.remove(id);
    send('gateways:changed', monitor.summaries());
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

  ipcMain.on('gateways:showing', (_event, id: string | null) => {
    deps.showing(typeof id === 'string' && store.get(id) ? id : null);
    if (id) monitor.refresh(id);
  });

  ipcMain.on('window:minimize', () => deps.window()?.minimize());
  ipcMain.on('window:toggleMaximize', () => {
    const window = deps.window();
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  });
  // Closing hides the window into the tray, as the system's own close button would.
  ipcMain.on('window:close', () => deps.window()?.close());

  ipcMain.handle('updates:check', () => checkNow());
  ipcMain.handle('settings:openAtLogin', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('settings:setOpenAtLogin', (_event, open: boolean) => {
    app.setLoginItemSettings({ openAtLogin: open === true });
  });

  return {
    changed: () => send('gateways:changed', monitor.summaries()),
    open: (target) => send('window:open', target),
  };
}

import { join } from 'node:path';
import { app, type BrowserWindow, powerMonitor } from 'electron';
import { LOCAL_GATEWAY_ID, type MachineUse, type OpenTarget, type Showing } from '../shared/bridge';
import { setAppMenu } from './app-menu';
import { serveBridge } from './bridge';
import { JianBrowser } from './browser';
import { timedFetch } from './gateways/fetch';
import { GatewayMonitor } from './gateways/monitor';
import { gatewayName } from './gateways/rules';
import { GatewayStore } from './gateways/store';
import { linkIn, linkTarget } from './link-target';
import { claimLinks } from './links';
import { localCredentials } from './local/credentials';
import { LocalGateway } from './local/process';
import { looksAt } from './looking';
import { MachineFile } from './machines/entries';
import { logMachines, UtilityWorkerHost } from './machines/host';
import { thisComputer } from './machines/identity';
import { MachineRegistry } from './machines/registry';
import { ComputerSharing } from './machines/sharing';
import { Notifier } from './notify';
import { notificationsOn } from './preferences';
import { handleScheme, registerScheme } from './protocol';
import { createTray, resourcesDir } from './tray';
import { type TrayState, trayMenu } from './tray-menu';
import { appUpdates } from './updates/electron';
import type { UpdateFlow } from './updates/flow';
import { serveUpdates } from './updates/ipc';
import { createWindow, reveal } from './window';

// From source the app keeps its own folder beside the installed one: its own lock, local gateway
// and saved gateways, so both run at once and neither reads the other's data.
if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Jian Dev'));

// One app, one window: a second launch only brings the first one forward.
if (!holdsLock()) app.exit(0);

/**
 * From source, a rebuild restarts the app while the old process still stops its gateway and
 * holds the lock: the new one waits for it, up to 15 seconds, instead of leaving at once. It
 * blocks, as nothing else may start before the lock is decided.
 */
function holdsLock(): boolean {
  if (app.requestSingleInstanceLock()) return true;
  if (app.isPackaged) return false;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 15_000; waited += 250) {
    Atomics.wait(pause, 0, 0, 250);
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

registerScheme();
// Windows shows notifications only for the app id its Start menu shortcut carries, which the
// installer sets to the bundle's id; Electron's own default id matches no shortcut.
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('com.jian.desktop');

let window: BrowserWindow | undefined;
let quitting = false;
/** Where the window is: what arrives anywhere else is announced, even while it has focus. */
let showing: Showing | null = null;
/** Where a notification asked to go before the window could take it. */
let pending: OpenTarget | undefined;
/** Created once the app is ready; told whenever what its menu shows changes. */
let tray: { update(): void } | undefined;

const browser = new JianBrowser(() => window);
browser.register();
const store = new GatewayStore();
const notifier = new Notifier((target) => open(target));
const monitor = new GatewayMonitor(store, app.getVersion(), {
  changed: () => {
    bridge.changed();
    machines.sync();
    tray?.update();
  },
  noticed: (notice) => {
    if (!notificationsOn() || looksAt(windowView(), showing, notice)) return;
    const gateway = store.get(notice.gatewayId);
    const name = gateway ? gatewayName(gateway) : '';
    notifier.show(notice, name, store.list().length > 1);
  },
});

function windowView() {
  if (!window || window.isDestroyed()) return undefined;
  return {
    visible: window.isVisible(),
    minimized: window.isMinimized(),
    focused: window.isFocused(),
  };
}

/** The chat open in a focused window is read: a notification about it has nothing left to say. */
function readShowing(): void {
  const chat = showing?.chat;
  if (!showing || !chat) return;
  const place = { gatewayId: showing.gatewayId, ...chat };
  if (looksAt(windowView(), showing, place)) notifier.dismiss(place);
}
// This computer as a machine on every server gateway the app knows, while it answers. Read
// once the app is ready, beside the rest of its start rather than before it: the window and the
// local gateway never wait on the vault for a machine's token.
const machineFile = new MachineFile();
const machinesLoaded = app.whenReady().then(() =>
  machineFile.load().catch((error: unknown) => {
    logMachines(`The saved machines could not be read: ${String(error)}`);
  }),
);
/** What agents are doing on this computer now, by gateway: the window shows it while it lasts. */
const using = new Map<string, MachineUse['kind']>();
const usingNow = (): MachineUse[] => [...using].map(([gatewayId, kind]) => ({ gatewayId, kind }));
const machines: ComputerSharing = new ComputerSharing({
  registry: new MachineRegistry({
    entries: machineFile,
    fetch: timedFetch(10_000),
    identity: thisComputer,
  }),
  host: new UtilityWorkerHost({
    refused: (gatewayId) => machines.refused(gatewayId),
    using: (gatewayId, kind) => {
      if (kind) using.set(gatewayId, kind);
      else using.delete(gatewayId);
      bridge.machinesUsing(usingNow());
    },
  }),
  setting: machineFile,
  gateways: () =>
    monitor.summaries().flatMap((summary) => {
      const gateway = store.get(summary.id);
      if (!gateway) return [];
      const access = { ...gateway, local: gateway.local === true, token: store.token(gateway) };
      return [{ gateway: access, online: summary.status === 'online' }];
    }),
  changed: () => {
    bridge.machinesChanged();
    tray?.update();
  },
  log: logMachines,
  loaded: machinesLoaded,
});
const bridge = serveBridge({
  retryLocal: () => local?.retry(),
  restartLocal: () => local?.restart() ?? Promise.resolve(),
  using: usingNow,
  store,
  monitor,
  machines,
  window: () => window,
  showing: (place) => {
    const moved = place?.gatewayId !== showing?.gatewayId;
    showing = place;
    browser.showing(place);
    readShowing();
    if (moved) tray?.update();
  },
  notificationsChanged: (on) => {
    if (!on) notifier.dismissAll();
  },
  listChanged: () => tray?.update(),
});
let updates: UpdateFlow | undefined;
const updatesBridge = serveUpdates(
  () => updates,
  () => window,
);

function open(target?: OpenTarget): void {
  if (!window) return;
  reveal(window);
  if (!target) return;
  // Sent while the window loads, a target is lost: it waits for the load. Once taken it is not
  // kept, or every reload of the window would open the chat, search or sheet again.
  if (window.webContents.isLoading()) pending = target;
  else bridge.open(target);
}

/** What the tray's menu shows: the gateways, the one the window shows, the computer's switch. */
function trayState(): TrayState {
  const server = store.list().some((gateway) => !gateway.local);
  return {
    gateways: monitor.summaries(),
    showing: showing?.gatewayId ?? null,
    sharing: server ? machines.sharing() : undefined,
  };
}

// A second launch brings this one forward, at the place a jian:// link asked for if one did.
app.on('second-instance', (_event, argv) => {
  const link = linkIn(argv);
  open(link ? linkTarget(link) : undefined);
});
// macOS hands links to the running app, or to the app it launches for them, through this.
app.on('open-url', (event, link) => {
  event.preventDefault();
  const target = linkTarget(link);
  if (window) open(target);
  else pending = target;
});
claimLinks();
// Closing the window keeps the app in the tray; only Quit ends it.
app.on('window-all-closed', () => {});
let local: LocalGateway | undefined;
let stopped = false;
let stopping: Promise<void> | undefined;
// The app's own gateway is stopped before the app ends, so its database closes cleanly, and
// this computer's workers tell their gateways it went offline. Once, whoever asks first: a quit,
// or an update about to hand the app to its installer.
const stopAll = () => {
  stopping ??= Promise.allSettled([local?.stop(), machines.stopAll()]).then(() => {
    stopped = true;
  });
  return stopping;
};
app.on('before-quit', (event) => {
  quitting = true;
  if (stopped) return;
  event.preventDefault();
  void stopAll().finally(() => app.quit());
});
app.on('activate', () => open());

// Not a top-level await: Electron finishes loading the main module before it is ready.
void app.whenReady().then(async () => {
  await store.load();
  const credentials = await localCredentials();
  store.setLocal(undefined, credentials.token);
  local = new LocalGateway(
    credentials,
    (url) => {
      store.setLocal(url, credentials.token);
      const gateway = store.get(LOCAL_GATEWAY_ID);
      if (gateway) monitor.watch(gateway);
      bridge.changed();
    },
    (reason) => monitor.failed(LOCAL_GATEWAY_ID, reason),
    browser,
  );
  void local.start();
  handleScheme(store, {
    dir: join(import.meta.dirname, '../renderer'),
    devServer: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
  });
  for (const gateway of store.list()) monitor.watch(gateway);
  // After sleep the gateways moved on without us; ask them at once rather than at the next tick.
  powerMonitor.on('resume', () => monitor.refresh());

  // From source the Dock shows Electron's icon; the packaged app has its own in the bundle.
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(join(resourcesDir(), 'icon.png'));
  }
  // Windows and Linux start the app with the link as an argument.
  const launchLink = linkIn(process.argv);
  if (launchLink) pending = linkTarget(launchLink);
  updates = appUpdates({
    window: () => window,
    show: () => {
      open();
      updatesBridge.show();
    },
    changed: (state) => updatesBridge.changed(state),
    // An install closes the window before the app quits: it must close, not hide into the tray.
    prepare: async () => {
      quitting = true;
      await stopAll();
    },
  });
  setAppMenu();
  window = createWindow({ quitting: () => quitting });
  browser.attach(window);
  window.on('focus', readShowing);
  window.webContents.on('did-finish-load', () => {
    if (pending) bridge.open(pending);
    pending = undefined;
  });
  tray = createTray({
    menu: () =>
      trayMenu(trayState(), {
        open,
        setSharing: (on) =>
          void machines
            .setSharing(on)
            .catch((error: unknown) =>
              logMachines(`Sharing could not be changed: ${String(error)}`),
            )
            // Refused, the checkbox the click already ticked goes back to how it stands.
            .finally(() => tray?.update()),
        quit: () => app.quit(),
      }),
    open: () => open(),
  });
  updates.start();
});

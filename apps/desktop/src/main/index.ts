import { join } from 'node:path';
import { app, type BrowserWindow, powerMonitor } from 'electron';
import { LOCAL_GATEWAY_ID, type OpenTarget } from '../shared/bridge';
import { serveBridge } from './bridge';
import { GatewayMonitor } from './gateways/monitor';
import { GatewayStore } from './gateways/store';
import { linkIn, linkTarget } from './link-target';
import { claimLinks } from './links';
import { localCredentials } from './local/credentials';
import { LocalGateway } from './local/process';
import { Notifier } from './notify';
import { handleScheme, registerScheme } from './protocol';
import { createTray, resourcesDir } from './tray';
import { keepUpdated } from './updates';
import { createWindow, reveal } from './window';

// One app, one window: a second launch only brings the first one forward.
if (!app.requestSingleInstanceLock()) app.exit(0);

registerScheme();

let window: BrowserWindow | undefined;
let quitting = false;
/** The gateway the window shows; replies there are the panel's to announce while it has focus. */
let showing: string | null = null;
/** Where a notification asked to go before the window could take it. */
let pending: OpenTarget | undefined;

const store = new GatewayStore();
const notifier = new Notifier((target) => open(target));
const monitor = new GatewayMonitor(store, app.getVersion(), {
  changed: () => bridge.changed(),
  replied: (reply) => {
    const seen = window?.isVisible() && window.isFocused() && showing === reply.gatewayId;
    if (seen) return;
    const name = store.get(reply.gatewayId)?.name ?? '';
    notifier.reply(reply, name, store.list().length > 1);
  },
});
const bridge = serveBridge({
  store,
  monitor,
  window: () => window,
  showing: (id) => {
    showing = id;
  },
});

function open(target?: OpenTarget): void {
  if (!window) return;
  reveal(window);
  if (target) {
    pending = target;
    bridge.open(target);
  }
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
// The app's own gateway is stopped before the app ends, so its database closes cleanly.
app.on('before-quit', (event) => {
  quitting = true;
  if (stopped || !local) return;
  event.preventDefault();
  void local.stop().finally(() => {
    stopped = true;
    app.quit();
  });
});
app.on('activate', () => open());

// Not a top-level await: Electron finishes loading the main module before it is ready.
void app.whenReady().then(async () => {
  await store.load();
  const credentials = await localCredentials();
  store.setLocal(undefined, credentials.token);
  local = new LocalGateway(credentials, (url) => {
    store.setLocal(url, credentials.token);
    const gateway = store.get(LOCAL_GATEWAY_ID);
    if (gateway) monitor.watch(gateway);
    bridge.changed();
  });
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
  window = createWindow({ quitting: () => quitting });
  window.webContents.on('did-finish-load', () => {
    if (pending) bridge.open(pending);
  });
  createTray({ open: () => open(), quit: () => app.quit() });
  keepUpdated();
});

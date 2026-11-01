import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, GatewaySummary, MachineUse, OpenTarget } from '../shared/bridge';
import { plainFailure } from '../shared/ipc-failure';
import type { UpdateState } from '../shared/updates';

/** Asks the main process; a failure reads as what it said. */
const invoke = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    throw plainFailure(error);
  });

/** Subscribes to a channel the main process sends on, and returns how to stop. */
function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge: DesktopBridge = {
  browser: {
    state: () => invoke('browser:state'),
    open: () => ipcRenderer.send('browser:open'),
    select: (pageId) => ipcRenderer.send('browser:select', pageId),
    adopt: (sessionId) => ipcRenderer.send('browser:adopt', sessionId),
    close: (pageId) => ipcRenderer.send('browser:close', pageId),
    navigate: (url) => invoke('browser:navigate', url),
    command: (command) => ipcRenderer.send('browser:command', command),
    layout: (bounds) => ipcRenderer.send('browser:layout', bounds),
    snapshot: () => invoke('browser:snapshot'),
    openExternal: () => ipcRenderer.send('browser:external'),
    shortcuts: (bindings) => ipcRenderer.send('browser:shortcuts', bindings),
    onShortcut: (listener) =>
      listen<import('../shared/bridge').BrowserShortcut>('browser:shortcut', listener),
    screenshot: () => invoke('browser:screenshot'),
    clear: (what) => invoke('browser:clear', what),
    places: () => invoke('browser:places'),
    setFavorite: (on, url, title) => invoke('browser:favorite', on, url, title),
    forget: (url) => invoke('browser:forget', url),
    cookieSources: () => invoke('browser:cookie-sources'),
    importCookies: (source, scope) => invoke('browser:import-cookies', source, scope),
    onChanged: (listener) =>
      listen<import('../shared/bridge').BrowserState>('browser:changed', listener),
  },
  version: ipcRenderer.sendSync('app:version'),
  platform: process.platform,
  gateways: () => invoke('gateways:list'),
  addGateway: (gateway) => invoke('gateways:add', gateway),
  removeGateway: (id) => invoke('gateways:remove', id),
  replaceToken: (id, token) => invoke('gateways:replaceToken', id, token),
  reconnectGateway: (id) => ipcRenderer.send('gateways:reconnect', id),
  onGatewaysChanged: (listener) => listen<GatewaySummary[]>('gateways:changed', listener),
  onOpen: (listener) => listen<OpenTarget>('window:open', listener),
  local: {
    retry: () => ipcRenderer.send('local:retry'),
    restart: () => invoke('local:restart'),
    openLog: () => ipcRenderer.send('local:openLog'),
  },
  showing: (place) => ipcRenderer.send('gateways:showing', place),
  openAtLogin: () => invoke('settings:openAtLogin'),
  notifications: () => invoke('settings:notifications'),
  setNotifications: (on) => invoke('settings:setNotifications', on),
  updates: {
    state: () => invoke('updates:state'),
    check: () => invoke('updates:check'),
    install: () => ipcRenderer.send('updates:install'),
    onChanged: (listener) => listen<UpdateState>('updates:changed', listener),
    onShow: (listener) => listen<null>('updates:show', () => listener()),
  },
  setOpenAtLogin: (open) => invoke('settings:setOpenAtLogin', open),
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    onMaximized: (listener) => listen<boolean>('window:maximized', listener),
  },
  pickFolder: () => invoke('dialog:pickFolder'),
  machines: {
    state: (gatewayId) => invoke('machines:state', gatewayId),
    onChanged: (listener) => listen<null>('machines:changed', () => listener()),
    using: () => invoke('machines:using'),
    onUsing: (listener) => listen<MachineUse[]>('machines:using', listener),
  },
};

contextBridge.exposeInMainWorld('jian', bridge);

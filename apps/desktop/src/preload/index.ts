import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, GatewaySummary, MachineUse, OpenTarget } from '../shared/bridge';
import type { UpdateState } from '../shared/updates';

/** Subscribes to a channel the main process sends on, and returns how to stop. */
function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge: DesktopBridge = {
  browser: {
    state: () => ipcRenderer.invoke('browser:state'),
    open: () => ipcRenderer.send('browser:open'),
    select: (pageId) => ipcRenderer.send('browser:select', pageId),
    close: (pageId) => ipcRenderer.send('browser:close', pageId),
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    command: (command) => ipcRenderer.send('browser:command', command),
    layout: (bounds) => ipcRenderer.send('browser:layout', bounds),
    snapshot: () => ipcRenderer.invoke('browser:snapshot'),
    openExternal: () => ipcRenderer.send('browser:external'),
    shortcuts: (bindings) => ipcRenderer.send('browser:shortcuts', bindings),
    onShortcut: (listener) =>
      listen<import('../shared/bridge').BrowserShortcut>('browser:shortcut', listener),
    screenshot: () => ipcRenderer.invoke('browser:screenshot'),
    clear: (what) => ipcRenderer.invoke('browser:clear', what),
    places: () => ipcRenderer.invoke('browser:places'),
    setFavorite: (on, url, title) => ipcRenderer.invoke('browser:favorite', on, url, title),
    forget: (url) => ipcRenderer.invoke('browser:forget', url),
    cookieSources: () => ipcRenderer.invoke('browser:cookie-sources'),
    importCookies: (source, scope) => ipcRenderer.invoke('browser:import-cookies', source, scope),
    onChanged: (listener) =>
      listen<import('../shared/bridge').BrowserState>('browser:changed', listener),
  },
  version: ipcRenderer.sendSync('app:version'),
  platform: process.platform,
  gateways: () => ipcRenderer.invoke('gateways:list'),
  addGateway: (gateway) => ipcRenderer.invoke('gateways:add', gateway),
  removeGateway: (id) => ipcRenderer.invoke('gateways:remove', id),
  replaceToken: (id, token) => ipcRenderer.invoke('gateways:replaceToken', id, token),
  onGatewaysChanged: (listener) => listen<GatewaySummary[]>('gateways:changed', listener),
  onOpen: (listener) => listen<OpenTarget>('window:open', listener),
  local: {
    retry: () => ipcRenderer.send('local:retry'),
    restart: () => ipcRenderer.invoke('local:restart'),
    openLog: () => ipcRenderer.send('local:openLog'),
  },
  showing: (place) => ipcRenderer.send('gateways:showing', place),
  openAtLogin: () => ipcRenderer.invoke('settings:openAtLogin'),
  notifications: () => ipcRenderer.invoke('settings:notifications'),
  setNotifications: (on) => ipcRenderer.invoke('settings:setNotifications', on),
  updates: {
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.send('updates:install'),
    onChanged: (listener) => listen<UpdateState>('updates:changed', listener),
    onShow: (listener) => listen<null>('updates:show', () => listener()),
  },
  setOpenAtLogin: (open) => ipcRenderer.invoke('settings:setOpenAtLogin', open),
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    onMaximized: (listener) => listen<boolean>('window:maximized', listener),
  },
  machines: {
    state: (gatewayId) => ipcRenderer.invoke('machines:state', gatewayId),
    setSharing: (on) => ipcRenderer.invoke('machines:setSharing', on),
    onChanged: (listener) => listen<null>('machines:changed', () => listener()),
    using: () => ipcRenderer.invoke('machines:using'),
    onUsing: (listener) => listen<MachineUse[]>('machines:using', listener),
  },
};

contextBridge.exposeInMainWorld('jian', bridge);

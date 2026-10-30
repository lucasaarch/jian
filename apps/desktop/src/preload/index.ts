import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, GatewaySummary, OpenTarget } from '../shared/bridge';

/** Subscribes to a channel the main process sends on, and returns how to stop. */
function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge: DesktopBridge = {
  version: ipcRenderer.sendSync('app:version'),
  platform: process.platform,
  gateways: () => ipcRenderer.invoke('gateways:list'),
  addGateway: (gateway) => ipcRenderer.invoke('gateways:add', gateway),
  renameGateway: (id, name) => ipcRenderer.invoke('gateways:rename', id, name),
  removeGateway: (id) => ipcRenderer.invoke('gateways:remove', id),
  replaceToken: (id, token) => ipcRenderer.invoke('gateways:replaceToken', id, token),
  onGatewaysChanged: (listener) => listen<GatewaySummary[]>('gateways:changed', listener),
  onOpen: (listener) => listen<OpenTarget>('window:open', listener),
  showing: (gatewayId) => ipcRenderer.send('gateways:showing', gatewayId),
  openAtLogin: () => ipcRenderer.invoke('settings:openAtLogin'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  setOpenAtLogin: (open) => ipcRenderer.invoke('settings:setOpenAtLogin', open),
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    onMaximized: (listener) => listen<boolean>('window:maximized', listener),
  },
};

contextBridge.exposeInMainWorld('jian', bridge);

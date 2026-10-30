import type { DesktopBridge } from '../shared/bridge';

declare global {
  interface Window {
    /** The main process, as the preload exposes it. */
    jian: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge => window.jian;

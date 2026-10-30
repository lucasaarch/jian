/**
 * What the main process and the window say to each other. The window never sees a gateway's
 * token: it names gateways by id, and the main process signs every request on its way out.
 */

export type GatewayStatus =
  /** Not asked yet since the app started or the gateway was added. */
  | 'connecting'
  | 'online'
  /** The gateway did not answer: down, or this computer is offline. */
  | 'offline'
  /** It answered, but refused the token: it was rotated on the server. */
  | 'unauthorized'
  /** It runs another major.minor than this app, so the panel would read shapes it does not know. */
  | 'incompatible';

export type GatewaySummary = {
  id: string;
  name: string;
  /** The gateway this app runs on this computer: always there, first, and never removed. */
  local: boolean;
  /** Where the gateway answers, as the owner typed it, without a trailing slash. */
  url: string;
  status: GatewayStatus;
  /** The gateway's release, once it answered; absent on a development build. */
  version?: string;
  /** Chats of the panel the agent wrote in since the owner last read them, across its agents. */
  unread: number;
};

export type NewGateway = { name: string; url: string; token: string };

export type AddGatewayResult = { ok: true; gateway: GatewaySummary } | { ok: false; error: string };

/** A place in a gateway's panel to open: where a notification leads. */
export type OpenTarget = { gatewayId: string; path: string };

export interface DesktopBridge {
  /** This app's release; 0.0.0-dev when built from source. */
  version: string;
  /** The system the app runs on, as Node names it: `darwin`, `win32`, `linux`. */
  platform: string;
  gateways(): Promise<GatewaySummary[]>;
  addGateway(gateway: NewGateway): Promise<AddGatewayResult>;
  renameGateway(id: string, name: string): Promise<void>;
  removeGateway(id: string): Promise<void>;
  /** A new host token for a gateway that refused the saved one, checked before it is kept. */
  replaceToken(id: string, token: string): Promise<{ ok: true } | { ok: false; error: string }>;
  onGatewaysChanged(listener: (gateways: GatewaySummary[]) => void): () => void;
  onOpen(listener: (target: OpenTarget) => void): () => void;
  /**
   * The gateway the window shows, or null. A reply there is the panel's to announce while the
   * window has focus; the main process notifies only for what the owner cannot see.
   */
  showing(gatewayId: string | null): void;
  openAtLogin(): Promise<boolean>;
  /** The window's own buttons, which the title bar draws on Windows and Linux. */
  windowControls: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    onMaximized(listener: (maximized: boolean) => void): () => void;
  };
  setOpenAtLogin(open: boolean): Promise<void>;
}

/** The id of the gateway this computer runs, among the ones the owner connected. */
export const LOCAL_GATEWAY_ID = 'local';

/** The scheme the window and its gateways are served from: one origin, so no CORS anywhere. */
export const APP_ORIGIN = 'jian://app';

/** Where the window reaches a gateway: the main process forwards it, signed. */
export const gatewayOrigin = (gatewayId: string) => `${APP_ORIGIN}/gateway/${gatewayId}`;

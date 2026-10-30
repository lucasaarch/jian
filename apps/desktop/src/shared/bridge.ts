/**
 * What the main process and the window say to each other. The window never sees a gateway's
 * token: it names gateways by id, and the main process signs every request on its way out.
 */
import type { UpdatesBridge } from './updates';

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

/** How a gateway stands, as the app says it: in the window and in the tray. */
export const STATUS_SAID: Record<GatewayStatus, string> = {
  online: 'Connected',
  connecting: 'Connecting',
  incompatible: 'Another release',
  offline: 'Not answering',
  unauthorized: 'Token refused',
};

export type GatewaySummary = {
  id: string;
  /** What it is called: this computer, or the host it answers at. */
  name: string;
  /** The gateway this app runs on this computer: always there, first, and never removed. */
  local: boolean;
  /** Where the gateway answers, as the owner typed it, without a trailing slash. */
  url: string;
  status: GatewayStatus;
  /** The gateway's release, once it answered; absent on a development build. */
  version?: string;
  /** Why the app's own gateway could not start, in its last words, while it cannot. */
  failure?: string;
  /** Chats of the panel the agent wrote in since the owner last read them, across its agents. */
  unread: number;
};

export type NewGateway = { url: string; token: string };

export type AddGatewayResult = { ok: true; gateway: GatewaySummary } | { ok: false; error: string };

/** Where the main process takes the window: from a notification, a jian:// link or the tray. */
export type OpenTarget =
  /** A place in a gateway's panel: a notification's chat, a link's page. */
  | { gatewayId: string; path: string }
  /**
   * A gateway's panel where it was left, with a new chat or the chat search opened there on the
   * agent it shows.
   */
  | { gatewayId: string; panel?: 'new-chat' | 'search-chats' }
  /** One of the window's own sheets, over whichever gateway it shows. */
  | { sheet: 'settings' | 'updates' };

/**
 * Where the window is: the gateway it shows and, when one is open, the conversation. The main
 * process announces what arrives anywhere else, so it needs the chat and not only the gateway.
 */
export type Showing = { gatewayId: string; chat?: { profileId: string; sessionId: string } };

/** An agent using this computer as a machine right now: on which gateway, and how. */
export type MachineUse = { gatewayId: string; kind: 'shell' | 'computer' };

export interface DesktopBridge {
  /** This app's release; 0.0.0-dev when built from source. */
  version: string;
  /** The system the app runs on, as Node names it: `darwin`, `win32`, `linux`. */
  platform: string;
  gateways(): Promise<GatewaySummary[]>;
  addGateway(gateway: NewGateway): Promise<AddGatewayResult>;
  removeGateway(id: string): Promise<void>;
  /** A new host token for a gateway that refused the saved one, checked before it is kept. */
  replaceToken(id: string, token: string): Promise<{ ok: true } | { ok: false; error: string }>;
  onGatewaysChanged(listener: (gateways: GatewaySummary[]) => void): () => void;
  onOpen(listener: (target: OpenTarget) => void): () => void;
  /** The app's own gateway: start it again now, or show the folder with its log. */
  local: { retry(): void; openLog(): void };
  /**
   * Where the window is, or null with no gateway shown. The main process notifies for every
   * conversation but the one open in a focused window.
   */
  showing(place: Showing | null): void;
  openAtLogin(): Promise<boolean>;
  /** Whether the app shows system notifications for replies, messages and what waits on the owner. */
  notifications(): Promise<boolean>;
  setNotifications(on: boolean): Promise<void>;
  /** The app's own releases: checked on start and every few hours, downloaded in the background. */
  updates: UpdatesBridge;
  /** The window's own buttons, which the title bar draws on Windows and Linux. */
  windowControls: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    onMaximized(listener: (maximized: boolean) => void): () => void;
  };
  setOpenAtLogin(open: boolean): Promise<void>;
  /**
   * This computer as a machine on the app's server gateways, so agents there can use its shell
   * and Computer Use. One switch for the whole computer, on by default; turned off, every worker
   * stops and the records stay on the gateways. The app's own gateway never has one.
   */
  machines: {
    /** This computer's machine on a gateway: its id there, once registered, and whether agents may use it. */
    state(gatewayId: string): Promise<{ machineId: string | null; sharing: boolean }>;
    setSharing(on: boolean): Promise<void>;
    onChanged(listener: () => void): () => void;
    /** What agents are doing on this computer now; empty while nothing is. */
    using(): Promise<MachineUse[]>;
    onUsing(listener: (uses: MachineUse[]) => void): () => void;
  };
}

/** The id of the gateway this computer runs, among the ones the owner connected. */
export const LOCAL_GATEWAY_ID = 'local';

/** The scheme the window and its gateways are served from: one origin, so no CORS anywhere. */
export const APP_ORIGIN = 'jian://app';

/** Where the window reaches a gateway: the main process forwards it, signed. */
export const gatewayOrigin = (gatewayId: string) => `${APP_ORIGIN}/gateway/${gatewayId}`;

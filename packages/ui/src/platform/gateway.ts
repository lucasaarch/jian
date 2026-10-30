/**
 * How the panel reaches its gateway. On the web it is the same origin, signed in by a cookie
 * the browser keeps and the header that stops it working from another origin; a native host
 * names the gateway's address and how it signs in. Set once, before the first request.
 */
export type GatewayConnection = {
  /** Where the panel sends its requests. */
  origin: string;
  headers: Record<string, string>;
  credentials: RequestCredentials;
  /**
   * Where the gateway answers the outside world, as channels, webhooks and remote workers are
   * told to reach it, when the panel's requests take another way there: a native host forwards
   * them through its own scheme.
   */
  publicOrigin?: string;
  /**
   * Whether the panel subscribes this device to the gateway's Web Push. A native host shows its
   * own system notifications instead, and has no service worker to receive them anyway.
   */
  push?: boolean;
  /**
   * Who holds the credential. On the web the panel signed in itself, with a cookie it can sign
   * out of; a native host signs each request with a token the panel never sees, so the panel
   * offers no sign-out of its own.
   */
  credential?: 'panel' | 'host';
};

let connection: GatewayConnection | undefined;

export function connectGateway(next: GatewayConnection) {
  connection = next;
}

export function gatewayConnection(): GatewayConnection {
  return (
    connection ?? {
      origin: window.location.origin,
      headers: { 'x-jian-panel': '1' },
      credentials: 'same-origin',
    }
  );
}

/** Where the gateway answers, as channels, webhooks and remote workers are told to reach it. */
export const gatewayOrigin = () => {
  const connection = gatewayConnection();
  return connection.publicOrigin ?? connection.origin;
};

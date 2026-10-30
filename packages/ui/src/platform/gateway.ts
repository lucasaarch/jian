/**
 * How the panel reaches its gateway. On the web it is the same origin, signed in by a cookie
 * the browser keeps and the header that stops it working from another origin; a native host
 * names the gateway's address and how it signs in. Set once, before the first request.
 */
export type GatewayConnection = {
  origin: string;
  headers: Record<string, string>;
  credentials: RequestCredentials;
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
export const gatewayOrigin = () => gatewayConnection().origin;

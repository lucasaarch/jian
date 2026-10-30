import type { GatewayStatus } from '../../shared/bridge';

/** How a gateway stands, as the app says it. */
export const STATUS_SAID: Record<GatewayStatus, string> = {
  online: 'Connected',
  connecting: 'Connecting',
  incompatible: 'Another release',
  offline: 'Not answering',
  unauthorized: 'Token refused',
};

/** The dot beside a gateway's name, in the colour of how it stands. */
export const STATUS_DOT: Record<GatewayStatus, string> = {
  online: 'bg-good',
  connecting: 'bg-muted',
  incompatible: 'bg-warn',
  offline: 'bg-bad',
  unauthorized: 'bg-bad',
};

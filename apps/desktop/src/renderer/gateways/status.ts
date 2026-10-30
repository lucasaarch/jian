import type { GatewayStatus } from '../../shared/bridge';

/** The dot beside a gateway's name, in the colour of how it stands. */
export const STATUS_DOT: Record<GatewayStatus, string> = {
  online: 'bg-good',
  connecting: 'bg-muted',
  incompatible: 'bg-warn',
  offline: 'bg-bad',
  unauthorized: 'bg-bad',
};

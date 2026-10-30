import { QueryClient } from '@tanstack/react-query';
import { type GatewayConnection, gatewayConnection } from '../../platform/gateway';
import { type GatewayApi, gatewayApi } from '../api';

let made: { api: GatewayApi; for: GatewayConnection } | undefined;

/**
 * The one client every query and every section shares, for the gateway the panel is connected
 * to. Created on first use, because it reads the panel's origin from `window`, which a server
 * render does not have; made again when a host connects the panel to another gateway, so no
 * request of the new gateway's panel goes to the one it left.
 */
export function panelApi(): GatewayApi {
  const connection = gatewayConnection();
  if (made?.for !== connection) made = { api: gatewayApi(), for: connection };

  return made.api;
}

/**
 * The gateway's event stream is what keeps the panel current: it invalidates exactly what an
 * event touched. Refetching on focus or reconnect would only repeat that work, and would ask
 * every provider for its models again.
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // A failure the gateway explained (401, 409, a validation) will not change on a retry.
        retry: 1,
      },
    },
  });
}

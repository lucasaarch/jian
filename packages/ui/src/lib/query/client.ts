import { QueryClient } from '@tanstack/react-query';
import { type GatewayConnection, gatewayConnection } from '../../platform/gateway';
import { type GatewayApi, gatewayApi } from '../api';
import { holdKeptQueries } from './kept';

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
 * event touched. Refetching on focus would only repeat that work, and would ask every provider
 * for its models again. A kept cache is the exception on reconnecting: no stream was open while
 * the gateway was out of reach, so what is on screen is read again once it answers. It also
 * holds its conversations and lists for good (`kept.ts`).
 */
export function createQueryClient({ kept = false }: { kept?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: kept,
        // A failure the gateway explained (401, 409, a validation) will not change on a retry.
        retry: 1,
      },
    },
  });
  if (kept) holdKeptQueries(client);

  return client;
}

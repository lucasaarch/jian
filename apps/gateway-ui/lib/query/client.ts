import { QueryClient } from '@tanstack/react-query';
import { type GatewayApi, gatewayApi } from '../api';

let api: GatewayApi | undefined;

/**
 * The one client every query and every section shares. Created on first use, because it reads
 * the panel's origin from `window`, which a server render does not have.
 */
export function panelApi(): GatewayApi {
  api ??= gatewayApi();

  return api;
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

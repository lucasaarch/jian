import { createJianClient } from '@jian/sdk';
import { gatewayConnection } from '../../platform/gateway';
import { channelCalls } from './channels';
import { readEvents } from './events';
import { integrationCalls } from './integrations';
import { profileCalls } from './profiles';
import { providerCalls } from './providers';
import { releaseCalls } from './releases';
import { resourceCalls } from './resources';
import { sessionCalls } from './sessions';

export * from './types';

/**
 * The panel never holds the host token: it trades it for a signed cookie the browser keeps and
 * no script can read. The header is what stops that cookie from working from another origin.
 */
export function gatewayApi() {
  const { origin, headers, credentials } = gatewayConnection();
  const client = createJianClient({
    baseUrl: origin,
    headers,
    fetch: (request, init) =>
      fetch(request, {
        ...init,
        cache: 'no-store',
        credentials,
        signal: init?.signal ?? AbortSignal.timeout(30_000),
      }),
  });

  return {
    ...profileCalls(client),
    ...providerCalls(client),
    ...releaseCalls(client),
    ...sessionCalls(client),
    ...channelCalls(client),
    ...integrationCalls(client),
    ...resourceCalls(client),
    events: readEvents,
  };
}

export type GatewayApi = ReturnType<typeof gatewayApi>;

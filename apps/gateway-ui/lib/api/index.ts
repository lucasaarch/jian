import { createJianClient } from '@jian/sdk';
import { channelCalls } from './channels';
import { readEvents } from './events';
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
  const client = createJianClient({
    baseUrl: window.location.origin,
    headers: { 'x-jian-panel': '1' },
    fetch: (request, init) =>
      fetch(request, {
        ...init,
        cache: 'no-store',
        credentials: 'same-origin',
        signal: init?.signal ?? AbortSignal.timeout(30_000),
      }),
  });

  return {
    ...profileCalls(client),
    ...providerCalls(client),
    ...releaseCalls(client),
    ...sessionCalls(client),
    ...channelCalls(client),
    ...resourceCalls(client),
    events: readEvents,
  };
}

export type GatewayApi = ReturnType<typeof gatewayApi>;

import { connectGateway, NavigationProvider, Notifications, QueryProvider } from '@jian/ui';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { type GatewaySummary, gatewayOrigin } from '../../shared/bridge';
import { Screen } from '../panel/routes';
import { navigationFor } from './navigation';
import { Starting, Unreachable } from './states';

/**
 * One gateway's panel. The app remounts it for another gateway (its key is the gateway's id), so
 * each one starts with its own cache and connection, and returns to its own place.
 */
export function GatewayPanel({ gateway }: { gateway: GatewaySummary }) {
  // Before the first query this panel makes: every request goes to the main process, which
  // signs it for this gateway. Web Push is off, since the app shows system notifications itself.
  useState(() =>
    connectGateway({
      origin: gatewayOrigin(gateway.id),
      publicOrigin: gateway.url,
      headers: {},
      credentials: 'same-origin',
      push: false,
      credential: 'host',
    }),
  );
  const memory = navigationFor(gateway.id);
  // The whole address, query included: the panel reads the query, the screens the path.
  const href = useSyncExternalStore(memory.subscribe, memory.current);
  const navigation = useMemo(() => memory.navigation(href), [memory, href]);
  const { pathname } = navigation;

  // The app's own gateway takes a moment after launch; the panel waits for it, not for a login.
  if (gateway.local && gateway.status !== 'online') return <Starting />;

  // The panel signs in when it cannot read the gateway; here there is nothing to type, only a
  // gateway that does not answer or no longer takes the token.
  if (pathname === '/sign-in') {
    return <Unreachable gateway={gateway} retry={() => memory.go('/')} />;
  }

  return (
    <QueryProvider>
      <NavigationProvider navigation={navigation}>
        <Screen pathname={pathname} />
        <Notifications />
      </NavigationProvider>
    </QueryProvider>
  );
}

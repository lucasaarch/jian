import {
  AgentsWorking,
  AppSettings,
  ChatsApp,
  CreateAgent,
  connectGateway,
  NavigationProvider,
  QueryProvider,
  SubscriptionMeter,
  useGatewayOnline,
} from '@jian/ui';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { type GatewaySummary, gatewayOrigin } from '../../shared/bridge';
import type { StatusSlots } from '../chrome/status-bar';
import { desktop } from '../desktop';
import { appHost, gatewaySettings } from '../settings/hosts';
import { useThisComputer } from '../settings/this-computer';
import { navigationFor } from './navigation';
import { Unreachable } from './states';

/**
 * One gateway, as the window shows it: its agents' chats, the agent chooser at the sidebar's
 * foot. The app remounts it for another gateway (its key is the gateway's id): each starts with
 * its own cache and connection, and returns to its own place.
 */
export function GatewayPanel({
  gateway,
  settings,
  slots,
}: {
  gateway: GatewaySummary;
  /** The app's settings, opened from anywhere in the window and drawn here with this gateway's. */
  settings: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    page: string;
    onPageChange: (page: string) => void;
  };
  /** The status bar's places for what this gateway tells: its agent at work, its limits. */
  slots: StatusSlots;
}) {
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
  const [creating, setCreating] = useState(false);
  // Out of reach — seen not answering, or the app's own still starting with no address yet —
  // the panel shows what it kept and waits for it. One still being reached is asked at once: a
  // read held until the first look would leave whatever was never kept loading meanwhile.
  const thisComputer = useThisComputer(gateway);
  useGatewayOnline(
    gateway.status !== 'offline' && !(gateway.status === 'connecting' && !gateway.url),
  );
  // The panel goes to sign in when it cannot read the gateway; here there is nothing to type,
  // only a gateway that does not answer or no longer takes the token.
  if (navigation.pathname === '/sign-in') {
    return (
      <>
        <Unreachable gateway={gateway} retry={() => memory.go('/')} />
        {/* Nothing of the gateway can be read here: only the app's own settings. */}
        <AppSettings {...settings} host={appHost} />
      </>
    );
  }

  return (
    // Everything read from this gateway is kept on this computer, as a messaging app keeps its
    // chats: it opens at once, and still reads while the gateway cannot be reached.
    <QueryProvider keep={{ key: gateway.id, release: desktop().version }}>
      <NavigationProvider navigation={navigation}>
        <ChatsApp createAgent={() => setCreating(true)} />
        {slots.start && createPortal(<AgentsWorking />, slots.start)}
        {slots.end && createPortal(<SubscriptionMeter />, slots.end)}
        <CreateAgent open={creating} onOpenChange={setCreating} />
        <AppSettings
          {...settings}
          host={appHost}
          gateway={{ ...gatewaySettings(gateway), ...(thisComputer ? { thisComputer } : {}) }}
        />
      </NavigationProvider>
    </QueryProvider>
  );
}

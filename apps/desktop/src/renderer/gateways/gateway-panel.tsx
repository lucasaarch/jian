import {
  AgentPicker,
  AgentSettings,
  ChatsApp,
  CreateAgent,
  connectGateway,
  NavigationProvider,
  QueryProvider,
} from '@jian/ui';
import { type ReactNode, useMemo, useState, useSyncExternalStore } from 'react';
import { type GatewaySummary, gatewayOrigin } from '../../shared/bridge';
import { useGatewayCommands } from '../commands/gateway-commands';
import { navigationFor } from './navigation';
import { Starting, Unreachable } from './states';

/**
 * One gateway, as the window shows it: its agent's chats, with the status bar beneath, which
 * gets the agent chooser here, where the gateway's agents can be read. The app remounts it for
 * another gateway (its key is the gateway's id): each starts with its own cache and connection,
 * and returns to its own place.
 */
export function GatewayPanel({
  gateway,
  statusBar,
}: {
  gateway: GatewaySummary;
  statusBar: (agent?: ReactNode) => ReactNode;
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
  const [agentSettings, setAgentSettings] = useState<string>();

  // The app's own gateway takes a moment after launch; the window waits for it, not for a login.
  if (gateway.local && gateway.status !== 'online') {
    return (
      <>
        <Starting />
        {statusBar()}
      </>
    );
  }
  // The panel goes to sign in when it cannot read the gateway; here there is nothing to type,
  // only a gateway that does not answer or no longer takes the token.
  if (navigation.pathname === '/sign-in') {
    return (
      <>
        <Unreachable gateway={gateway} retry={() => memory.go('/')} />
        {statusBar()}
      </>
    );
  }

  return (
    <QueryProvider>
      <NavigationProvider navigation={navigation}>
        <ChatsApp createAgent={() => setCreating(true)} />
        <GatewayCommands />
        {statusBar(
          <AgentPicker openSettings={setAgentSettings} createAgent={() => setCreating(true)} />,
        )}
        <CreateAgent open={creating} onOpenChange={setCreating} />
        <AgentSettings
          profileId={agentSettings}
          onOpenChange={(open) => !open && setAgentSettings(undefined)}
        />
      </NavigationProvider>
    </QueryProvider>
  );
}

/** The gateway's commands, offered from inside its panel, where its agent can be read. */
function GatewayCommands() {
  useGatewayCommands();
  return null;
}

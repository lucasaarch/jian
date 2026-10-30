import { ThemeSync } from '@jian/ui';
import { useEffect, useState } from 'react';
import { TitleBar } from './chrome/title-bar';
import { desktop } from './desktop';
import { AddGateway } from './gateways/add-gateway';
import { GatewayBar } from './gateways/gateway-bar';
import { GatewayPanel } from './gateways/gateway-panel';
import { openIn } from './gateways/navigation';
import { Incompatible } from './gateways/states';
import { useGateways, useSelectedGateway } from './gateways/use-gateways';

/**
 * The window: the chosen gateway's panel above, every gateway in the bar below. It opens on the
 * app's own gateway, ready to use; connecting another is something the owner chooses to do.
 */
export function App() {
  const { gateways, loaded } = useGateways();
  const { current, select } = useSelectedGateway(gateways);
  const [adding, setAdding] = useState(false);

  // A notification leads to its gateway and chat, whichever gateway was showing.
  useEffect(
    () =>
      desktop().onOpen(({ gatewayId, path }) => {
        openIn(gatewayId, path);
        select(gatewayId);
        setAdding(false);
      }),
    [select],
  );

  if (!loaded) return null;

  let body: React.ReactNode;
  if (!current || adding) {
    body = (
      <AddGateway
        added={(gateway) => {
          select(gateway.id);
          setAdding(false);
        }}
        cancel={() => setAdding(false)}
      />
    );
  } else if (current.status === 'incompatible') {
    body = <Incompatible gateway={current} />;
  } else {
    body = <GatewayPanel key={current.id} gateway={current} />;
  }

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <TitleBar gateway={adding ? undefined : current} />
      {/* The panel sizes itself to the window; the app's own screens scroll when it is short.
          Layout containment makes this area the box the panel's fixed sidebar and dialogs are
          placed in, so they sit between the title bar and the gateway bar, not over them. */}
      <div className="min-h-0 flex-1 overflow-y-auto [contain:layout]">{body}</div>
      <GatewayBar
        gateways={gateways}
        current={adding ? undefined : current}
        select={(id) => {
          select(id);
          setAdding(false);
        }}
        add={() => setAdding(true)}
      />
      <ThemeSync />
    </div>
  );
}

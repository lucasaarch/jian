import { ThemeSync } from '@jian/ui';
import { useEffect, useState } from 'react';
import { StatusBar } from './chrome/status-bar';
import { TitleBar } from './chrome/title-bar';
import { desktop } from './desktop';
import { AddGateway } from './gateways/add-gateway';
import { GatewayPanel } from './gateways/gateway-panel';
import { GatewayPicker } from './gateways/gateway-picker';
import { GatewaySettings } from './gateways/gateway-settings';
import { openIn } from './gateways/navigation';
import { Incompatible } from './gateways/states';
import { useGateways, useSelectedGateway } from './gateways/use-gateways';
import { AppSettings } from './settings/app-settings';

/**
 * The window: the chats of the gateway and agent in use, the status bar choosing both beneath
 * them, and every setting in overlays above. It opens on the app's own gateway, ready to use.
 */
export function App() {
  const { gateways, loaded } = useGateways();
  const { current, select } = useSelectedGateway(gateways);
  const [settings, setSettings] = useState(false);
  const [gatewaySettings, setGatewaySettings] = useState<string>();
  const [connecting, setConnecting] = useState(false);

  // A notification leads to its gateway and chat, whichever gateway was showing.
  useEffect(
    () =>
      desktop().onOpen(({ gatewayId, path }) => {
        openIn(gatewayId, path);
        select(gatewayId);
      }),
    [select],
  );

  // ⌘, on macOS and Ctrl+, elsewhere, as every app opens its settings.
  useEffect(() => {
    const mac = desktop().platform === 'darwin';
    const keys = (event: KeyboardEvent) => {
      if (event.key !== ',' || !(mac ? event.metaKey : event.ctrlKey)) return;
      event.preventDefault();
      setSettings(true);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  if (!loaded) return null;

  const statusBar = (agent?: React.ReactNode) => (
    <StatusBar
      gateway={
        <GatewayPicker
          gateways={gateways}
          {...(current ? { current } : {})}
          select={select}
          openSettings={setGatewaySettings}
          connect={() => setConnecting(true)}
        />
      }
      agent={agent}
      openSettings={() => setSettings(true)}
    />
  );

  return (
    <div className="app-window flex h-dvh flex-col">
      <TitleBar gateway={current} />
      {/* Layout containment makes this area the box the panel's fixed pieces are placed in. */}
      <div className="flex min-h-0 flex-1 flex-col [contain:layout]">
        {current?.status === 'incompatible' ? (
          <>
            <Incompatible gateway={current} />
            {statusBar()}
          </>
        ) : current ? (
          <GatewayPanel key={current.id} gateway={current} statusBar={statusBar} />
        ) : (
          statusBar()
        )}
      </div>
      <AppSettings open={settings} onOpenChange={setSettings} />
      <GatewaySettings
        gateway={gateways.find((gateway) => gateway.id === gatewaySettings)}
        onOpenChange={(open) => !open && setGatewaySettings(undefined)}
      />
      <AddGateway
        open={connecting}
        onOpenChange={setConnecting}
        added={(gateway) => select(gateway.id)}
      />
      <ThemeSync />
    </div>
  );
}

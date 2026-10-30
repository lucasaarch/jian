import { AppSettings, AppUpdates, Notifications, openUpdates, ThemeSync } from '@jian/ui';
import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { StatusBar } from './chrome/status-bar';
import { TitleBar } from './chrome/title-bar';
import { CommandsProvider } from './commands/registry';
import { useWindowCommands } from './commands/window-commands';
import { desktop } from './desktop';
import { AddGateway } from './gateways/add-gateway';
import { GatewayPanel } from './gateways/gateway-panel';
import { GatewayPicker } from './gateways/gateway-picker';
import { openIn } from './gateways/navigation';
import { Incompatible } from './gateways/states';
import { useGateways, useSelectedGateway } from './gateways/use-gateways';
import { appHost, updatesHost } from './settings/hosts';

/**
 * The window: the chats of the gateway and agent in use, the status bar choosing the gateway
 * beneath them, and every setting in overlays above. It opens on the app's own gateway, ready to use.
 */
export function App() {
  return (
    <CommandsProvider>
      <Window />
    </CommandsProvider>
  );
}

function Window() {
  const { gateways, loaded } = useGateways();
  const { current, select } = useSelectedGateway(gateways);
  const [settings, setSettings] = useState(false);
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

  // The notification of a ready release leads to the update sheet.
  useEffect(() => desktop().updates.onShow(() => openUpdates()), []);

  const openSettings = useCallback(() => setSettings(true), []);
  const mac = desktop().platform === 'darwin';
  useWindowCommands(openSettings);

  if (!loaded) return null;

  return (
    <div
      className="relative flex h-dvh flex-col bg-canvas"
      // Windows and Linux draw the window's buttons over the top right: what sits there keeps clear.
      style={{ '--window-controls': mac ? '0px' : '8.25rem' } as CSSProperties}
    >
      <TitleBar gateway={current} />
      {/* Layout containment makes this area the box the panel's fixed pieces are placed in. */}
      <div className="flex min-h-0 flex-1 flex-col [contain:layout]">
        {current?.status === 'incompatible' ? (
          <Incompatible gateway={current} />
        ) : current ? (
          <GatewayPanel
            key={current.id}
            gateway={current}
            settings={{ open: settings, onOpenChange: setSettings }}
          />
        ) : null}
      </div>
      <StatusBar
        gateway={
          <GatewayPicker
            gateways={gateways}
            {...(current ? { current } : {})}
            select={select}
            connect={() => setConnecting(true)}
          />
        }
        openSettings={openSettings}
      />
      {/* With a gateway in use, its panel draws the settings, where that gateway can be read. */}
      {!(current && current.status !== 'incompatible') && (
        <AppSettings open={settings} onOpenChange={setSettings} host={appHost} />
      )}
      <AddGateway
        open={connecting}
        onOpenChange={setConnecting}
        added={(gateway) => select(gateway.id)}
      />
      <AppUpdates host={updatesHost} />
      <ThemeSync />
      <Notifications />
    </div>
  );
}

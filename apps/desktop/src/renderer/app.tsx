import {
  AppSettings,
  AppUpdates,
  CommandsProvider,
  ComputerInUse,
  Notifications,
  openUpdates,
  ReloadCurtain,
  searchChats,
  ThemeSync,
  useWelcomeShowing,
} from '@jian/ui';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useComputerUses } from './chrome/computer-uses';
import { StatusBar, type StatusSlots } from './chrome/status-bar';
import { TitleBar } from './chrome/title-bar';
import { useWindowCommands } from './commands/window-commands';
import { desktop } from './desktop';
import { AddGateway } from './gateways/add-gateway';
import { GatewayPanel } from './gateways/gateway-panel';
import { GatewayPicker } from './gateways/gateway-picker';
import { openIn, openNewChat } from './gateways/navigation';
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
  const welcoming = useWelcomeShowing();
  const { current, select } = useSelectedGateway(gateways);
  // The settings page open, or none while they are closed; they reopen where they were left.
  const [settingsPage, setSettingsPage] = useState<string>();
  const left = useRef('general');
  const [connecting, setConnecting] = useState(false);

  const openSettings = useCallback((page?: string) => setSettingsPage(page ?? left.current), []);

  // A notification leads to its gateway and chat, whichever gateway was showing; the tray to a
  // gateway, a new chat or the chat search there, or a sheet. The place is set before the
  // gateway is selected, so its panel mounts on it.
  useEffect(
    () =>
      desktop().onOpen((target) => {
        if ('sheet' in target) {
          if (target.sheet === 'settings') openSettings();
          else openUpdates({ check: true });
          return;
        }
        if ('path' in target) openIn(target.gatewayId, target.path);
        else if (target.panel === 'new-chat') openNewChat(target.gatewayId);
        else if (target.panel === 'search-chats') searchChats();
        select(target.gatewayId);
      }),
    [select, openSettings],
  );

  // The notification of a ready release leads to the update sheet.
  useEffect(() => desktop().updates.onShow(() => openUpdates()), []);
  const settings = {
    open: settingsPage !== undefined,
    page: settingsPage ?? left.current,
    onOpenChange: (open: boolean) => (open ? openSettings() : setSettingsPage(undefined)),
    onPageChange: (page: string) => {
      left.current = page;
      setSettingsPage(page);
    },
  };
  const connect = useCallback(() => setConnecting(true), []);
  // Where the gateway in use draws its own words into the status bar.
  const [slots, setSlots] = useState<StatusSlots>({ start: null, end: null });
  const slotRefs = useMemo(
    () => ({
      start: (start: HTMLElement | null) => setSlots((current) => ({ ...current, start })),
      end: (end: HTMLElement | null) => setSlots((current) => ({ ...current, end })),
    }),
    [],
  );
  const uses = useComputerUses(gateways);
  const mac = desktop().platform === 'darwin';
  useWindowCommands({ openSettings, gateways, current, select, connect });

  if (!loaded) return null;

  return (
    <div
      className="relative flex h-dvh flex-col bg-canvas"
      // Windows and Linux draw the window's buttons over the top right: what sits there keeps clear.
      // The Welcome takes the whole window: no status bar under it.
      style={
        {
          '--window-controls': mac ? '0px' : '8.25rem',
          ...(welcoming ? { '--status-bar': '0px', '--app-height': '100dvh' } : {}),
        } as CSSProperties
      }
    >
      <TitleBar gateway={current} />
      {/* Layout containment makes this area the box the panel's fixed pieces are placed in. */}
      <div className="flex min-h-0 flex-1 flex-col [contain:layout]">
        {current?.status === 'incompatible' ? (
          <Incompatible gateway={current} />
        ) : current ? (
          <GatewayPanel key={current.id} gateway={current} settings={settings} slots={slots} />
        ) : null}
      </div>
      {!welcoming && (
        <StatusBar
          gateway={
            <GatewayPicker
              gateways={gateways}
              {...(current ? { current } : {})}
              select={select}
              connect={connect}
            />
          }
          computer={<ComputerInUse uses={uses} open={() => openSettings('machines')} />}
          slots={slotRefs}
          openSettings={() => openSettings()}
        />
      )}
      {/* With a gateway in use, its panel draws the settings, where that gateway can be read. */}
      {!(current && current.status !== 'incompatible') && (
        <AppSettings {...settings} host={appHost} />
      )}
      <AddGateway
        open={connecting}
        onOpenChange={setConnecting}
        added={(gateway) => select(gateway.id)}
      />
      <AppUpdates host={updatesHost} />
      <ThemeSync />
      <Notifications />
      <ReloadCurtain />
    </div>
  );
}

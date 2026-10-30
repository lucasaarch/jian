import { type AppCommand, openUpdates, useAppCommands, useCommands } from '@jian/ui';
import { ArrowLeftRight, RefreshCw, ServerCog } from 'lucide-react';
import { createElement, useMemo } from 'react';
import type { GatewaySummary } from '../../shared/bridge';

/**
 * The commands of the window itself, whatever gateway is open: the app's shared ones, and what
 * only the app has — its updates and the gateways it keeps.
 */
export function useWindowCommands({
  openSettings,
  gateways,
  current,
  select,
  connect,
}: {
  openSettings: (page?: string) => void;
  gateways: GatewaySummary[];
  current: GatewaySummary | undefined;
  select: (id: string) => void;
  connect: () => void;
}): void {
  useAppCommands(openSettings);
  const commands = useMemo<AppCommand[]>(
    () => [
      ...gateways
        .filter((gateway) => gateway.id !== current?.id)
        .map<AppCommand>((gateway) => ({
          id: `switch-gateway-${gateway.id}`,
          title: `Switch to ${gateway.name}`,
          detail: 'Gateway',
          keywords: ['gateway', 'server', 'change'],
          icon: createElement(ArrowLeftRight, { size: 15 }),
          run: () => select(gateway.id),
        })),
      {
        id: 'connect-gateway',
        title: 'Connect a gateway',
        keywords: ['add', 'server', 'gateway', 'remote'],
        icon: createElement(ServerCog, { size: 15 }),
        run: connect,
      },
      {
        id: 'updates',
        title: 'Check for updates',
        keywords: ['update', 'version', 'release', 'upgrade'],
        icon: createElement(RefreshCw, { size: 15 }),
        run: () => openUpdates({ check: true }),
      },
    ],
    [gateways, current, select, connect],
  );
  useCommands('window', commands);
}

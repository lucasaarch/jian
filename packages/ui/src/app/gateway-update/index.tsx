'use client';

import { useQuery } from '@tanstack/react-query';
import { CloudDownload } from 'lucide-react';
import { useMemo } from 'react';
import { useGatewayMode } from '../../lib/gateway-mode';
import { type AppCommand, useCommands } from '../commands/registry';
import { updateStatus } from './query';
import { askToUpdate } from './store';
import { GatewayUpdateDialog } from './update-dialog';

/**
 * Updating a server installation from anywhere in the panel: the dialog, and the palette's
 * "Update gateway to X.Y.Z" while a release is waiting and a way to install it is set up. A
 * desktop app's own gateway updates with the app, so it has neither.
 */
export function GatewayUpdate() {
  const server = useGatewayMode() === 'server';
  const status = useQuery({ ...updateStatus(), enabled: server }).data;
  const version = server && status?.method !== 'none' ? status?.latest?.version : undefined;

  useCommands(
    'gateway-update',
    useMemo<AppCommand[]>(
      () =>
        version
          ? [
              {
                id: 'update-gateway',
                group: 'Gateway',
                title: `Update gateway to ${version}`,
                keywords: ['update', 'upgrade', 'release', 'version', 'deploy', 'install'],
                icon: <CloudDownload size={15} />,
                run: askToUpdate,
              },
            ]
          : [],
      [version],
    ),
  );

  return server ? <GatewayUpdateDialog /> : null;
}

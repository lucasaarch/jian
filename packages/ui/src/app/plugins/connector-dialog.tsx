'use client';

import { type ReactNode, Suspense } from 'react';
import { GitHubLogo, XLogo } from '../../components/ui';
import { Overlay, SettingsCardSkeleton } from '../../kit';
import { useActions } from '../../lib/workspace';
import { AwsCard } from '../settings/aws-card';
import { GitHubCard } from '../settings/github-card';
import { AppIcon, McpAppCard } from '../settings/mcp-app-card';
import { awsMark } from '../settings/mcp-apps';
import { XCard } from '../settings/x-card';
import { type Connector, connectorMeta, isVerified } from './connectors';
import { CustomConnector } from './custom-connector';
import { VerifiedBadge } from './plugin-list';

/**
 * A connector's mark, in the text colour: the service's own for one Jian provides, and the
 * initial of its name for a custom one, which has none.
 */
export function ConnectorIcon({ connector }: { connector: Connector }): ReactNode {
  const { source } = connector;
  if (source.kind === 'github') return <GitHubLogo size={16} />;
  if (source.kind === 'x') return <XLogo size={14} />;
  if (source.kind === 'aws') return <AppIcon app={{ icon: awsMark }} size={16} />;
  if (source.kind === 'app') return <AppIcon app={source.app} size={16} />;
  return (
    <span className="text-xs font-semibold uppercase">
      {connector.name.trim().charAt(0) || '?'}
    </span>
  );
}

/**
 * What connects it, as it always has: the card of each of Jian's own, with its accounts and its
 * sign-in behind it, and for a custom one its line, with everything else behind Configure.
 */
function ConnectorCard({ connector, close }: { connector: Connector; close: () => void }) {
  const { api } = useActions();
  const { source } = connector;
  if (source.kind === 'github') return <GitHubCard api={api} />;
  if (source.kind === 'x') return <XCard api={api} />;
  if (source.kind === 'aws') return <AwsCard />;
  if (source.kind === 'app') return <McpAppCard app={source.app} />;
  return <CustomConnector server={source.server} close={close} />;
}

/**
 * One connector, opened from its row: its name, whose it is, and what connects it. `connector`
 * stays set while this closes, so it fades out as it was.
 */
export function ConnectorDialog({
  connector,
  open,
  onOpenChange,
}: {
  connector: Connector | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={connector?.name ?? 'Connector'}
      size="form"
    >
      {connector && (
        <div className="grid w-full grid-cols-1 gap-5 p-7">
          <header className="grid gap-1 pr-10">
            <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight">
              <span className="min-w-0 truncate">{connector.name}</span>
              {isVerified(connector) && <VerifiedBadge />}
            </h2>
            <p className="text-sm text-muted">{connectorMeta(connector)}</p>
          </header>
          <Suspense fallback={<SettingsCardSkeleton />}>
            <ConnectorCard connector={connector} close={() => onOpenChange(false)} />
          </Suspense>
        </div>
      )}
    </Overlay>
  );
}

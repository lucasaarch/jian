import type { ReactNode } from 'react';
import { GitHubLogo, XLogo } from '../../components/ui';
import { awsMark, type McpApp } from '../settings/mcp-apps';
import type { Connector } from './connectors';

/** An app's mark in the text colour, as GitHub's and X's are. */
function AppIcon({ app, size }: { app: Pick<McpApp, 'icon'>; size: number }) {
  return (
    <svg
      viewBox={app.icon.viewBox ?? '0 0 24 24'}
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={app.icon.path} />
    </svg>
  );
}

/**
 * A connector's mark, in the text colour: the service's own for one Jian provides, and the
 * initial of its name for a custom one, which has none. `large` is the size of its page's tile;
 * a row's is smaller.
 */
export function ConnectorIcon({
  connector,
  large = false,
}: {
  connector: Connector;
  large?: boolean;
}): ReactNode {
  const { source } = connector;
  const size = large ? 20 : 16;
  // X's mark fills its box, so it is drawn a little smaller to weigh the same as the rest.
  if (source.kind === 'github') return <GitHubLogo size={size} />;
  if (source.kind === 'x') return <XLogo size={size - 2} />;
  if (source.kind === 'aws') return <AppIcon app={{ icon: awsMark }} size={size} />;
  if (source.kind === 'app') return <AppIcon app={source.app} size={size} />;
  return (
    <span className={`font-semibold uppercase ${large ? 'text-base' : 'text-xs'}`}>
      {connector.name.trim().charAt(0) || '?'}
    </span>
  );
}

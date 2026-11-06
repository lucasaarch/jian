'use client';

import { AppsPage, AppsWaiting } from './settings/apps-page';
import { CapabilitiesPage, CapabilitiesWaiting } from './settings/capabilities-page';
import { MachinesPage, MachinesWaiting, type ThisComputer } from './settings/machines-page';
import { McpServersPage, McpServersWaiting } from './settings/mcp-servers-page';
import { MobilePage, MobileWaiting } from './settings/mobile-page';
import { ProvidersPage, ProvidersWaiting } from './settings/providers-page';
import { SshKeysPage, SshKeysWaiting } from './settings/ssh-keys-page';

export type GatewayPageId =
  | 'providers'
  | 'models'
  | 'apps'
  | 'mcp-servers'
  | 'ssh-keys'
  | 'machines'
  | 'mobile';

/** Each page's shape while it is read, so the page lands where its skeleton stood. */
export function GatewayPageWaiting({ page }: { page: GatewayPageId }) {
  if (page === 'providers') return <ProvidersWaiting />;
  if (page === 'models') return <CapabilitiesWaiting />;
  if (page === 'apps') return <AppsWaiting />;
  if (page === 'mcp-servers') return <McpServersWaiting />;
  if (page === 'ssh-keys') return <SshKeysWaiting />;
  if (page === 'mobile') return <MobileWaiting />;
  return <MachinesWaiting />;
}

/**
 * One of the gateway's own pages, read through the panel that is connected to it, so it shows
 * what that gateway has and changes it there.
 */
export function GatewayPage({
  page,
  thisComputer,
}: {
  page: GatewayPageId;
  /** The computer the app runs on, for a host that is that app. */
  thisComputer?: ThisComputer | undefined;
}) {
  if (page === 'providers') return <ProvidersPage />;
  if (page === 'models') return <CapabilitiesPage />;
  if (page === 'apps') return <AppsPage />;
  if (page === 'mcp-servers') return <McpServersPage />;
  if (page === 'ssh-keys') return <SshKeysPage />;
  if (page === 'mobile') return <MobilePage />;
  return <MachinesPage thisComputer={thisComputer} />;
}

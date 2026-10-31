'use client';

import { CapabilitiesPage, CapabilitiesWaiting } from './settings/capabilities-page';
import { IntegrationsPage, IntegrationsWaiting } from './settings/integrations-page';
import { MachinesPage, MachinesWaiting, type ThisComputer } from './settings/machines-page';
import { ProvidersPage, ProvidersWaiting } from './settings/providers-page';
import { SshKeysPage, SshKeysWaiting } from './settings/ssh-keys-page';

export type GatewayPageId = 'providers' | 'models' | 'integrations' | 'ssh-keys' | 'machines';

/** Each page's shape while it is read, so the page lands where its skeleton stood. */
export function GatewayPageWaiting({ page }: { page: GatewayPageId }) {
  if (page === 'providers') return <ProvidersWaiting />;
  if (page === 'models') return <CapabilitiesWaiting />;
  if (page === 'integrations') return <IntegrationsWaiting />;
  if (page === 'ssh-keys') return <SshKeysWaiting />;
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
  if (page === 'integrations') return <IntegrationsPage />;
  if (page === 'ssh-keys') return <SshKeysPage />;
  return <MachinesPage thisComputer={thisComputer} />;
}

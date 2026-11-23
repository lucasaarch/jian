'use client';

import { UpdatesPage, UpdatesWaiting } from './gateway-update/updates-page';
import { CapabilitiesPage, CapabilitiesWaiting } from './settings/capabilities-page';
import { MachinesPage, MachinesWaiting, type ThisComputer } from './settings/machines-page';
import { MobilePage, MobileWaiting } from './settings/mobile-page';
import { ProvidersPage, ProvidersWaiting } from './settings/providers-page';
import { SshKeysPage, SshKeysWaiting } from './settings/ssh-keys-page';

export type GatewayPageId = 'providers' | 'models' | 'ssh-keys' | 'machines' | 'mobile' | 'updates';

/** Each page's shape while it is read, so the page lands where its skeleton stood. */
export function GatewayPageWaiting({ page }: { page: GatewayPageId }) {
  if (page === 'providers') return <ProvidersWaiting />;
  if (page === 'models') return <CapabilitiesWaiting />;
  if (page === 'ssh-keys') return <SshKeysWaiting />;
  if (page === 'mobile') return <MobileWaiting />;
  if (page === 'updates') return <UpdatesWaiting />;
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
  if (page === 'ssh-keys') return <SshKeysPage />;
  if (page === 'mobile') return <MobilePage />;
  if (page === 'updates') return <UpdatesPage />;
  return <MachinesPage thisComputer={thisComputer} />;
}

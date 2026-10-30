'use client';

import { IntegrationsPage } from './settings/integrations-page';
import { MachinesPage, type ThisComputer } from './settings/machines-page';
import { ModelDefaultsPage } from './settings/model-defaults-page';
import { ProvidersPage } from './settings/providers-page';
import { SshKeysPage } from './settings/ssh-keys-page';

export type GatewayPageId = 'providers' | 'models' | 'integrations' | 'ssh-keys' | 'machines';

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
  if (page === 'models') return <ModelDefaultsPage />;
  if (page === 'integrations') return <IntegrationsPage />;
  if (page === 'ssh-keys') return <SshKeysPage />;
  return <MachinesPage thisComputer={thisComputer} />;
}

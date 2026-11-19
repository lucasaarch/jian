'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { SectionActions } from '../../components/props';
import type { Credential } from '../../components/providers/accounts';
import type { ProviderEntry } from '../../components/providers/connection';
import { Action, Overlay, OverlayActions, StatusPill } from '../../kit';
import type { Provider } from '../../lib/api';
import { AccountList } from './provider-accounts';
import { ConnectForm } from './provider-form';
import { ProviderTitle } from './provider-title';

/**
 * One of Anthropic's two credentials, shown as a provider of its own: an API key, or a Claude
 * Code token from `claude setup-token`. The gateway keeps one Anthropic account active at a
 * time, across both.
 */
export type AnthropicAs = {
  credential: Credential;
  name: string;
  description: string;
  /** Said while the other credential's account is the active one: adding here switches. */
  replaces?: string;
};

/**
 * One provider's accounts: each one listed, the active one marked, with the way to make another
 * active, rename it or remove it, and Add another account, which opens the connect form. With
 * no account yet the form is all there is. Its credential is written there and never shown back.
 */
export function ProviderDialog({
  entry,
  as,
  accounts,
  environment,
  stale,
  open,
  onOpenChange,
  actions,
}: {
  entry: ProviderEntry | undefined;
  /** For Anthropic, which of its credentials this dialog is about. */
  as?: AnthropicAs;
  /** This provider's live accounts. */
  accounts: Provider[];
  /** A key the gateway reads from its environment, standing in while no account is stored. */
  environment?: Provider | undefined;
  /** The active account's models could not be listed. */
  stale: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: SectionActions;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={as?.name ?? entry?.name ?? 'Provider'}
      size="form"
    >
      {entry && (
        <ProviderAccounts
          key={`${entry.kind}-${as?.credential ?? ''}`}
          entry={entry}
          {...(as ? { as } : {})}
          accounts={accounts}
          environment={environment}
          stale={stale}
          close={() => onOpenChange(false)}
          actions={actions}
        />
      )}
    </Overlay>
  );
}

function ProviderAccounts({
  entry,
  as,
  accounts,
  environment,
  stale,
  close,
  actions,
}: {
  entry: ProviderEntry;
  as?: AnthropicAs;
  accounts: Provider[];
  environment: Provider | undefined;
  stale: boolean;
  close: () => void;
  actions: SectionActions;
}) {
  const [adding, setAdding] = useState(false);
  const name = as?.name ?? entry.name;
  const inUse = accounts.some((account) => account.active) || Boolean(environment);
  const header = (
    <header className="grid gap-1.5 pr-10">
      <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
        <ProviderTitle kind={entry.kind}>{name}</ProviderTitle>
        {inUse && (
          <StatusPill tone={stale ? 'bad' : 'good'}>
            {stale ? 'Unreachable' : 'Connected'}
          </StatusPill>
        )}
      </h2>
      <p className="text-sm leading-relaxed text-muted">
        {as?.description ?? entry.description}
        {!inUse && !as && entry.variables
          ? ` Or set ${entry.variables} where the gateway runs.`
          : ''}
      </p>
    </header>
  );

  if (adding || (accounts.length === 0 && !environment)) {
    return (
      <ConnectForm
        entry={entry}
        {...(as ? { as } : {})}
        header={header}
        another={accounts.length > 0}
        environment={environment}
        // Back to the list it was opened from, or closed when there is none.
        cancel={accounts.length > 0 ? () => setAdding(false) : close}
        done={close}
        actions={actions}
      />
    );
  }

  return (
    <div className="grid w-full gap-5 p-7">
      {header}
      {as?.replaces && !inUse && (
        <p className="rounded-lg bg-warn/10 px-3 py-2.5 text-xs leading-relaxed text-warn">
          {as.replaces}
        </p>
      )}
      <AccountList
        service={name}
        accounts={accounts}
        environment={accounts.length === 0 ? environment : undefined}
        actions={actions}
      />
      <OverlayActions>
        <Action tone="outline" onClick={() => setAdding(true)} disabled={actions.busy}>
          <Plus size={14} aria-hidden="true" />
          {accounts.length > 0 ? 'Add another account' : 'Add account'}
        </Action>
        <span className="flex-1" />
        <Action tone="quiet" onClick={close}>
          Close
        </Action>
      </OverlayActions>
    </div>
  );
}

'use client';

import { Menu } from '@base-ui/react/menu';
import { useQueries, useQuery } from '@tanstack/react-query';
import { CircleCheck, Ellipsis, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { SectionActions } from '../../components/props';
import { accountFacts, accountName } from '../../components/providers/accounts';
import { staleLine } from '../../components/providers/connection';
import {
  ConfirmDialog,
  iconButton,
  MenuEntry,
  menuPopup,
  RenameDialog,
  SettingsGroup,
  SettingsRow,
  StatusPill,
} from '../../kit';
import type { Provider, ProviderModelList, SubscriptionUsage } from '../../lib/api';
import { queries } from '../../lib/query/profile';

/** The newest account but the one leaving: the gateway makes it active when the active one goes. */
const successorOf = (accounts: Provider[], leaving: Provider) =>
  accounts
    .filter((account) => account.id !== leaving.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

/**
 * The accounts of one provider, a card of them as a connector lists its own: each by its name,
 * the active one marked, with what it is, its models and its subscription's use, and a menu to
 * make it active, rename it or remove it. Removing asks first; removing the last one disconnects
 * the provider, so that question wants its name typed. A key from the gateway's environment is
 * shown with them and changed only there.
 */
export function AccountList({
  service,
  accounts,
  environment,
  actions,
}: {
  /** What the accounts are of, as the questions name it: "Claude Code". */
  service: string;
  accounts: Provider[];
  environment?: Provider | undefined;
  actions: SectionActions;
}) {
  const { api, mutate, busy } = actions;
  const lists = useQueries({
    queries: accounts.map((account) => queries.providerModels(account.id)),
  });
  // Only a subscription has windows to show; nothing else asks for them.
  const subscribed = accounts.some(
    (account) => account.authMode === 'codex' || account.credential === 'subscription',
  );
  const usage = useQuery({ ...queries.subscriptionUsage(), enabled: subscribed }).data ?? [];
  const [renaming, setRenaming] = useState<Provider>();
  const [removing, setRemoving] = useState<Provider>();
  const [asking, setAsking] = useState(false);
  const last = removing && accounts.length === 1;
  const next = removing?.active ? successorOf(accounts, removing) : undefined;
  const active = accounts.find((account) => account.active);

  return (
    <>
      <SettingsGroup title="Accounts" note={accounts.length > 1 ? 'Runs use the active one' : ''}>
        {environment && (
          <SettingsRow
            title="From the environment"
            description={`${environment.apiKeyEnv} where the gateway runs. Change it there.`}
          />
        )}
        {accounts.map((account, index) => (
          <AccountRow
            key={account.id}
            account={account}
            list={lists[index]?.data}
            usage={usage.find((item) => item.providerId === account.id)}
            busy={busy}
            activate={() =>
              void mutate(
                () => api.activateProviderAccount(account.id),
                `${accountName(account)} is now the active ${service} account.`,
              )
            }
            rename={() => setRenaming(account)}
            remove={() => {
              setRemoving(account);
              setAsking(true);
            }}
          />
        ))}
      </SettingsGroup>
      {renaming && (
        <RenameDialog
          open={Boolean(renaming)}
          onOpenChange={(open) => !open && setRenaming(undefined)}
          name={accountName(renaming)}
          renaming={{
            what: 'account',
            maxLength: 60,
            rename: (label) =>
              mutate(() => api.renameProviderAccount(renaming.id, label), 'Account renamed.'),
          }}
        />
      )}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${removing ? accountName(removing) : ''}?`}
        {...(last && removing ? { phrase: accountName(removing) } : {})}
        action="Remove account"
        busy={busy}
        run={async () => {
          if (!removing) return;
          if (
            await mutate(() => api.revokeProvider(removing.id), `${accountName(removing)} removed.`)
          )
            setAsking(false);
        }}
      >
        Its credential is deleted from the gateway.{' '}
        {last
          ? `It is the last ${service} account: agents can no longer use its models until you connect one again.`
          : next
            ? `Runs move to ${accountName(next)}, the newest account left.`
            : active
              ? `Runs keep using ${accountName(active)}.`
              : ''}
      </ConfirmDialog>
    </>
  );
}

function AccountRow({
  account,
  list,
  usage,
  busy,
  activate,
  rename,
  remove,
}: {
  account: Provider;
  list: ProviderModelList | undefined;
  usage: SubscriptionUsage | undefined;
  busy: boolean;
  activate: () => void;
  rename: () => void;
  remove: () => void;
}) {
  const name = accountName(account);
  const stale = staleLine(list);

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{name}</span>
          {account.active && <StatusPill tone="good">Active</StatusPill>}
          {stale && <StatusPill tone="bad">Unreachable</StatusPill>}
        </span>
      }
      description={
        <>
          {accountFacts(account, list, usage)}
          {stale && <span className="block text-bad">{stale}</span>}
        </>
      }
    >
      <Menu.Root>
        <Menu.Trigger aria-label={`Actions for ${name}`} className={iconButton} disabled={busy}>
          <Ellipsis size={15} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Menu.Popup className={menuPopup}>
              {!account.active && (
                <MenuEntry icon={<CircleCheck size={14} />} onClick={activate}>
                  Make active
                </MenuEntry>
              )}
              <MenuEntry icon={<Pencil size={14} />} onClick={rename}>
                Rename
              </MenuEntry>
              <MenuEntry icon={<Trash2 size={14} />} danger onClick={remove}>
                Remove
              </MenuEntry>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </SettingsRow>
  );
}

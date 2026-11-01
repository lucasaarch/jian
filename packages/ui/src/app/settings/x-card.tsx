'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import {
  useXAccounts,
  useXOutcome,
  type XAccount,
  type XIntegration,
} from '../../components/integrations/x-actions';
import { XLogo } from '../../components/ui';
import {
  Action,
  ConfirmDialog,
  Overlay,
  OverlayActions,
  SettingsRow,
  StatusPill,
  TextField,
} from '../../kit';
import type { GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { queries } from '../../lib/query/profile';
import { notifyError } from '../../lib/workspace';

const needsAttention = (account: XAccount) =>
  account.status === 'needs_attention' || account.missingScopes.length > 0;

/**
 * X's line among the apps, on either kind of gateway: a desktop's own gets its address from the
 * app. It needs an address X accepts to send the owner back to, so a gateway without one says so
 * and offers nothing it could not finish.
 */
export function XRow({ api }: { api: GatewayApi }) {
  const { data: integration } = useQuery(queries.xIntegration());
  const accounts = useXAccounts(api);
  const [open, setOpen] = useState(false);

  useXOutcome();

  const connected = integration?.accounts ?? [];
  // A gateway that cannot do it, whatever the reason, does not offer it: AppsCard decides the same.
  if (!integration?.callbackUrl) return null;

  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {/* The mark is the X of the name: written too, it would read twice. */}
            <XLogo size={13} />
            <span>
              <span className="sr-only">X </span>MCP
            </span>
            {connected.length > 0 && <StatusPill tone="good">Connected</StatusPill>}
            {connected.some(needsAttention) && <StatusPill tone="warn">Needs attention</StatusPill>}
          </span>
        }
      >
        <Action
          tone="outline"
          size="small"
          aria-label={connected.length > 0 ? 'Configure X' : 'Connect X'}
          onClick={() => setOpen(true)}
        >
          {connected.length > 0 ? 'Configure' : 'Connect'}
        </Action>
      </SettingsRow>
      <Overlay open={open} onOpenChange={setOpen} title="X MCP" size="form">
        <XSettings
          api={api}
          integration={integration}
          accounts={accounts}
          close={() => setOpen(false)}
        />
      </Overlay>
    </>
  );
}

function Heading({ integration }: { integration: XIntegration }) {
  return (
    <header className="grid gap-1.5 pr-10">
      <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
        <XLogo size={16} />
        <span>
          <span className="sr-only">X </span>MCP
        </span>
        {integration.accounts.length > 0 && <StatusPill tone="good">Connected</StatusPill>}
      </h2>
      <p className="text-sm leading-relaxed text-muted">
        Your own X developer app, used for every account you connect. Every agent can use them, and
        what they do is billed to your app's credits.
      </p>
    </header>
  );
}

/** The address to paste into X's app, ready to copy. */
function CallbackUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch (error) {
      notifyError(error, 'Select the address and copy it by hand.');
    }
  };

  return (
    <div className="grid gap-1.5">
      <span className="text-[13px] text-muted">
        Callback URL for the X app's settings, exactly as written here
      </span>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-glass-edge bg-glass-hover px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{url}</code>
        <Action
          tone="quiet"
          size="small"
          aria-label="Copy the callback URL"
          onClick={() => void copy()}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </Action>
      </div>
    </div>
  );
}

/** Once a gateway: the secret goes to its vault and never comes back, so it is always typed anew. */
function AppForm({
  api,
  integration,
  close,
}: {
  api: GatewayApi;
  integration: XIntegration;
  close: () => void;
}) {
  const client = useQueryClient();
  const [clientId, setClientId] = useState(integration.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      client.setQueryData(keys.xIntegration, await api.saveXApp({ clientId, clientSecret }));
      toast.success(
        integration.accounts.length > 0 ? 'X app saved.' : 'X app saved. Now connect an account.',
      );
      close();
    } catch (error) {
      notifyError(error, "The X app's credentials could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
      <p className="text-[13px] leading-relaxed text-muted">
        In X's Developer Console, turn on OAuth 2.0 for your app as a Web App, with Read and write
        and Direct message permissions, then copy its OAuth 2.0 client id and secret here.
      </p>
      <TextField
        label="Client ID"
        value={clientId}
        autoComplete="off"
        required
        onChange={(event) => setClientId(event.target.value)}
      />
      <TextField
        label="Client secret"
        type="password"
        value={clientSecret}
        autoComplete="off"
        required
        hint="Kept in this gateway's vault, and never shown again."
        onChange={(event) => setClientSecret(event.target.value)}
      />
      <OverlayActions>
        {integration.configured && (
          <Action tone="quiet" onClick={close}>
            Cancel
          </Action>
        )}
        <Action tone="primary" type="submit" busy={saving}>
          Save
        </Action>
      </OverlayActions>
    </form>
  );
}

function AccountRow({
  account,
  accounts,
}: {
  account: XAccount;
  accounts: ReturnType<typeof useXAccounts>;
}) {
  const [asking, setAsking] = useState(false);
  const attention = needsAttention(account);

  return (
    <li className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
      <span className="grid min-w-0 flex-1 basis-40">
        <span className="truncate text-[13px] text-ink">@{account.handle}</span>
        {attention && (
          <span className="text-xs text-warn">
            {account.status === 'needs_attention'
              ? 'X no longer accepts its sign-in. Connect it again.'
              : 'Connected with fewer permissions than Jian uses. Connect it again.'}
          </span>
        )}
      </span>
      {attention && <StatusPill tone="warn">Needs attention</StatusPill>}
      <Action tone="danger" size="small" onClick={() => setAsking(true)}>
        Disconnect
      </Action>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Disconnect @${account.handle}?`}
        action="Disconnect"
        busy={accounts.disconnecting === account.id}
        run={() => void accounts.disconnect(account).then(() => setAsking(false))}
      >
        Every agent using it loses it, and Jian forgets its sign-in. X keeps listing Jian among the
        account's connected apps until it is revoked there.
      </ConfirmDialog>
    </li>
  );
}

function XSettings({
  api,
  integration,
  accounts,
  close,
}: {
  api: GatewayApi;
  integration: XIntegration;
  accounts: ReturnType<typeof useXAccounts>;
  close: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const form = editing || !integration.configured;

  return (
    <div className="grid w-full grid-cols-1 gap-5 p-7">
      <Heading integration={integration} />
      {integration.callbackUrl && <CallbackUrl url={integration.callbackUrl} />}
      {form ? (
        <AppForm
          api={api}
          integration={integration}
          // Saved, the overlay stays: connecting an account is what comes next.
          close={() => setEditing(false)}
        />
      ) : (
        <>
          {integration.accounts.length > 0 && (
            <ul className="divide-y divide-glass-edge rounded-xl border border-glass-edge bg-glass-hover">
              {integration.accounts.map((account) => (
                <AccountRow key={account.id} account={account} accounts={accounts} />
              ))}
            </ul>
          )}
          <p className="rounded-lg bg-ink/5 px-3 py-2.5 text-xs leading-relaxed text-muted">
            X signs in whichever account your browser is logged into. To connect another one, switch
            account on x.com first.
          </p>
          <OverlayActions>
            <Action
              tone={integration.accounts.length > 0 ? 'outline' : 'primary'}
              busy={accounts.connecting}
              onClick={() => void accounts.connect()}
            >
              <Plus size={14} />
              Connect account
            </Action>
            <Action tone="quiet" onClick={() => setEditing(true)}>
              Change app
            </Action>
            <span className="flex-1" />
            <Action tone="quiet" onClick={close}>
              Close
            </Action>
          </OverlayActions>
        </>
      )}
    </div>
  );
}

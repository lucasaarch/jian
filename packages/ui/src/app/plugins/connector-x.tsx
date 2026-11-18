'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import {
  useXAccounts,
  type XAccount,
  type XIntegration,
} from '../../components/integrations/x-actions';
import {
  Action,
  ConfirmDialog,
  SettingsGroup,
  SettingsRow,
  StatusPill,
  TextField,
} from '../../kit';
import { keys } from '../../lib/query/keys';
import { notifyError, useActions } from '../../lib/workspace';
import { ConnectorFrame, Note, reading, since } from './connector-frame';
import type { Connector } from './connectors';

const needsAttention = (account: XAccount) =>
  account.status === 'needs_attention' || account.missingScopes.length > 0;

/**
 * X, on its page, on either kind of gateway: a desktop's own gets its address from the app. It
 * runs on a developer app of the owner's, so the page first asks for that app's credentials,
 * with the callback address X must be given; once they are saved, Connect account signs one in,
 * and the page lists the accounts with their disconnection.
 */
export function XConnector({
  connector,
  integration,
  back,
}: {
  connector: Connector;
  integration: XIntegration;
  back: () => void;
}) {
  const { api } = useActions();
  const accounts = useXAccounts(api);
  const [changing, setChanging] = useState(false);
  const connected = integration.accounts;
  const form = changing || !integration.configured;

  return (
    <ConnectorFrame
      connector={connector}
      back={back}
      lead="Your own X developer app, used for every account you connect. Every agent can use them, and what they do is billed to your app's credits."
      actions={
        integration.configured && (
          <Action
            tone={connected.length > 0 ? 'outline' : 'primary'}
            size="field"
            busy={accounts.connecting}
            onClick={() => void accounts.connect()}
          >
            Connect account
          </Action>
        )
      }
      details={[
        [
          'Status',
          connected.length === 0
            ? 'Not connected'
            : connected.some(needsAttention)
              ? 'Needs attention'
              : 'Connected',
        ],
        ['Type', 'Jian app'],
        ['Auth', 'OAuth'],
        ['Accounts', connected.length],
        ['Added', since(connected.map((account) => account.connectedAt))],
      ]}
    >
      {connected.length > 0 && (
        <SettingsGroup title="Accounts">
          {connected.map((account) => (
            <AccountRow key={account.id} account={account} accounts={accounts} />
          ))}
        </SettingsGroup>
      )}
      {integration.configured && (
        <Note>
          X signs in whichever account your browser is logged into. To connect another one, switch
          account on x.com first.
        </Note>
      )}
      <SettingsGroup title="Developer app">
        {integration.callbackUrl && <CallbackUrl url={integration.callbackUrl} />}
        {!form && (
          <SettingsRow
            title="Client ID"
            description={<span className="font-mono">{integration.clientId}</span>}
          >
            <Action
              tone="outline"
              size="small"
              aria-label="Change the X app"
              onClick={() => setChanging(true)}
            >
              Change
            </Action>
          </SettingsRow>
        )}
      </SettingsGroup>
      {form && (
        <AppForm
          integration={integration}
          // Saved, the page stays: connecting an account is what comes next.
          close={() => setChanging(false)}
        />
      )}
    </ConnectorFrame>
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
    <SettingsRow
      title="Callback URL"
      description={
        <>
          For the X app's settings, exactly as written here:{' '}
          <code className="font-mono text-ink [overflow-wrap:anywhere]">{url}</code>
        </>
      }
    >
      <Action
        tone="outline"
        size="small"
        aria-label="Copy the callback URL"
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </Action>
    </SettingsRow>
  );
}

/** Once a gateway: the secret goes to its vault and never comes back, so it is always typed anew. */
function AppForm({ integration, close }: { integration: XIntegration; close: () => void }) {
  const { api } = useActions();
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
    <form
      aria-label="X app credentials"
      className={`grid gap-4 ${reading}`}
      onSubmit={(event) => void submit(event)}
    >
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
      <div className="flex items-center justify-end gap-2">
        {integration.configured && (
          <Action tone="quiet" size="field" onClick={close}>
            Cancel
          </Action>
        )}
        <Action tone="primary" size="field" type="submit" busy={saving}>
          Save
        </Action>
      </div>
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
    <SettingsRow
      title={`@${account.handle}`}
      description={
        attention ? (
          <span className="text-warn">
            {account.status === 'needs_attention'
              ? 'X no longer accepts its sign-in. Connect it again.'
              : 'Connected with fewer permissions than Jian uses. Connect it again.'}
          </span>
        ) : (
          account.name
        )
      }
    >
      {attention && <StatusPill tone="warn">Needs attention</StatusPill>}
      <Action
        tone="danger"
        size="small"
        aria-label={`Disconnect @${account.handle}`}
        onClick={() => setAsking(true)}
      >
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
    </SettingsRow>
  );
}

'use client';

import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  appPermissionsUrl,
  type GithubIntegration,
  installationUrl,
  useGithubInstallations,
  useGithubRegistration,
} from '../../components/integrations/github-actions';
import { Action, SettingsGroup, SettingsRow } from '../../kit';
import { LOCALE } from '../../lib/format';
import { useGatewayMode } from '../../lib/gateway-mode';
import { keys } from '../../lib/query/keys';
import { useActions } from '../../lib/workspace';
import { ExternalAction } from '../settings/integration-parts';
import { ConnectorFrame, Note, reading, since } from './connector-frame';
import type { Connector } from './connectors';

type App = NonNullable<GithubIntegration['app']>;

const requestedOn = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long' });

/**
 * GitHub, on its page, connected or not, on a gateway that offers it. Connecting registers
 * Jian's App the first time and an account after; once one is in, the page lists the accounts
 * the App reaches, each with GitHub's own page for it and its disconnection, and says anything
 * GitHub still has to grant. A member who is not an owner of an organization only requests the
 * App there: the request is listed until an owner approves it and the gateway connects it, and
 * Connect an approved installation picks up one GitHub already has.
 */
export function GithubConnector({
  connector,
  integration,
  back,
}: {
  connector: Connector;
  integration: GithubIntegration;
  back: () => void;
}) {
  const { api } = useActions();
  const { registering, register } = useGithubRegistration(api);
  const { connecting, connect, connectingApproved, connectApproved, disconnecting, disconnect } =
    useGithubInstallations(api);
  const app = integration.configured ? integration.app : undefined;
  const accounts = integration.accounts;
  const pending = integration.pending ?? [];
  // GitHub's webhook, which connects an approved request by itself, cannot reach a desktop
  // app's own gateway.
  const watched = useGatewayMode() !== 'local';
  const attention =
    Boolean(app) &&
    (integration.permissionsVerified === false ||
      (integration.missingPermissions ?? []).length > 0);

  return (
    <ConnectorFrame
      connector={connector}
      back={back}
      lead="GitHub's tools for every agent: each account in any chat, and only its repository in a project's chat."
      actions={
        <>
          {app && (
            <Action
              tone="outline"
              size="field"
              busy={connectingApproved}
              onClick={() => void connectApproved()}
            >
              Connect an approved installation
            </Action>
          )}
          {app && accounts.length > 0 ? (
            <Action tone="outline" size="field" busy={connecting} onClick={() => void connect()}>
              Add account
            </Action>
          ) : (
            <Action
              tone="primary"
              size="field"
              aria-label="Connect GitHub"
              busy={registering || connecting}
              onClick={() => void (app ? connect() : register())}
            >
              Connect
            </Action>
          )}
        </>
      }
      details={[
        [
          'Status',
          accounts.length === 0 ? 'Not connected' : attention ? 'Needs attention' : 'Connected',
        ],
        ['Type', 'Jian app'],
        ['Auth', 'GitHub App'],
        ['App', app?.name],
        ['Added', since(accounts.map((account) => account.connectedAt))],
      ]}
    >
      {app && <Permissions integration={integration} app={app} />}
      {accounts.length > 0 && (
        <SettingsGroup title="Accounts">
          {accounts.map((account) => (
            <SettingsRow
              key={account.id}
              title={account.login}
              description={account.type === 'Organization' ? 'Organization' : 'Personal account'}
            >
              <ExternalAction href={installationUrl(account)}>Access</ExternalAction>
              <Action
                tone="danger"
                size="small"
                aria-label={`Disconnect ${account.login}`}
                busy={disconnecting === account.id}
                onClick={() => void disconnect(account.id)}
              >
                Disconnect
              </Action>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}
      {pending.length > 0 && (
        <SettingsGroup title="Waiting for an owner to approve">
          {pending.map((request) => (
            <SettingsRow
              key={request.login}
              title={request.login}
              description={`Asked on ${requestedOn.format(Date.parse(request.requestedAt))}. It connects here by itself once an organization owner approves it.`}
            />
          ))}
        </SettingsGroup>
      )}
      {app && (
        <Note>
          For an organization you are not an owner of, Connect asks its owners for the App.{' '}
          {watched
            ? 'Once one approves it, it connects here by itself, or from Connect an approved installation.'
            : 'Once one approves it, connect it from Connect an approved installation.'}
        </Note>
      )}
      {!app && (
        <Note>
          The first time, Connect registers a GitHub App of your own for this gateway, which you
          confirm on GitHub. After that it connects an account, and you choose the repositories the
          App reaches.
        </Note>
      )}
    </ConnectorFrame>
  );
}

/**
 * Whether GitHub granted the App what its tools need. Said only when it did not, or when GitHub
 * could not be asked.
 */
function Permissions({ integration, app }: { integration: GithubIntegration; app: App }) {
  const client = useQueryClient();
  const missing = integration.missingPermissions ?? [];

  if (integration.permissionsVerified === false) {
    return (
      <div
        className={`flex items-center gap-3 rounded-lg bg-ink/5 px-3 py-2.5 text-xs text-muted ${reading}`}
      >
        <span className="flex-1">
          GitHub could not be asked about the App's permissions. Check again once it answers.
        </span>
        <Action
          tone="outline"
          size="small"
          onClick={() => void client.invalidateQueries({ queryKey: keys.githubIntegration })}
        >
          <RefreshCw size={13} />
          Check again
        </Action>
      </div>
    );
  }

  if (!integration.permissionsVerified || missing.length === 0) return null;

  return (
    <div
      className={`grid gap-2 rounded-lg bg-warn/10 px-3 py-2.5 text-xs leading-relaxed text-warn ${reading}`}
    >
      <span>
        GitHub has not granted {missing.join(', ')}. Grant them to the App, then approve the change
        for each account.
      </span>
      <span>
        <ExternalAction href={appPermissionsUrl(app)}>Permissions on GitHub</ExternalAction>
      </span>
    </div>
  );
}

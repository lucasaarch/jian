'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
  appPermissionsUrl,
  type GithubIntegration,
  installationUrl,
  useGithubInstallations,
  useGithubRegistration,
} from '../../components/integrations/github-actions';
import { useGithubOutcome } from '../../components/integrations/github-outcome';
import { GitHubLogo } from '../../components/ui';
import { Action, Overlay, SettingsGroup, SettingsRow, StatusPill } from '../../kit';
import type { GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { useReportFailure } from '../../lib/query/notify';
import { queries } from '../../lib/query/profile';
import { ExternalAction } from './integration-parts';

type App = NonNullable<GithubIntegration['app']>;

/**
 * The apps agents reach through the gateway, a line each: GitHub, connected or not. Connecting
 * registers Jian's App the first time and an account after; once one is in, Configure holds the
 * accounts, the way to add another and anything GitHub still has to grant.
 */
export function AppsCard({ api }: { api: GatewayApi }) {
  const { data: integration, isPending: loading } = useReportFailure(
    useQuery(queries.githubIntegration()),
    'GitHub integration could not load.',
  );
  const { registering, register } = useGithubRegistration(api);
  const installations = useGithubInstallations(api);
  const [open, setOpen] = useState(false);

  useGithubOutcome();

  const app = integration?.configured ? integration.app : undefined;
  const accounts = integration?.accounts ?? [];
  const missing = integration?.missingPermissions ?? [];
  const attention =
    Boolean(app) && (integration?.permissionsVerified === false || missing.length > 0);
  // GitHub registers the App only for a gateway it can send the owner back to.
  const blocked = !app && !loading && !integration?.callbackUrl;

  return (
    <>
      <SettingsGroup title="Apps">
        <SettingsRow
          title={
            <span className="flex items-center gap-2">
              <GitHubLogo size={14} />
              GitHub
              {accounts.length > 0 && <StatusPill tone="good">Connected</StatusPill>}
              {attention && <StatusPill tone="warn">Needs attention</StatusPill>}
            </span>
          }
          {...(blocked
            ? {
                description: (
                  <>
                    Set <code className="font-mono">JIAN_PUBLIC_URL</code> to this gateway's public
                    HTTPS address to connect it.
                  </>
                ),
              }
            : {})}
        >
          {app && accounts.length > 0 ? (
            <Action
              tone="outline"
              size="small"
              aria-label="Configure GitHub"
              onClick={() => setOpen(true)}
            >
              Configure
            </Action>
          ) : (
            <Action
              tone="outline"
              size="small"
              aria-label="Connect GitHub"
              busy={registering || installations.connecting}
              disabled={loading || blocked}
              onClick={() => void (app ? installations.connect() : register())}
            >
              Connect
            </Action>
          )}
        </SettingsRow>
      </SettingsGroup>
      <Overlay open={open} onOpenChange={setOpen} title="GitHub" size="form">
        {integration && app && (
          <GitHubSettings
            integration={integration}
            app={app}
            installations={installations}
            close={() => setOpen(false)}
          />
        )}
      </Overlay>
    </>
  );
}

/** The accounts Jian's App reaches, each with GitHub's own page for it and its disconnection. */
function GitHubSettings({
  integration,
  app,
  installations: { connecting, connect, disconnecting, disconnect },
  close,
}: {
  integration: GithubIntegration;
  app: App;
  installations: ReturnType<typeof useGithubInstallations>;
  close: () => void;
}) {
  return (
    <div className="grid w-full gap-5 p-7">
      <header className="grid gap-1.5 pr-6">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <GitHubLogo size={18} />
          GitHub
          <StatusPill tone="good">Connected</StatusPill>
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          GitHub's tools for every agent: each account in any chat, and only its repository in a
          project's chat.
        </p>
      </header>
      <Permissions integration={integration} app={app} />
      <ul className="divide-y divide-glass-edge rounded-xl border border-glass-edge bg-glass-hover">
        {integration.accounts.map((account) => (
          <li key={account.id} className="flex items-center gap-3 px-3.5 py-2.5">
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{account.login}</span>
            <ExternalAction href={installationUrl(account)}>Access</ExternalAction>
            <Action
              tone="danger"
              size="small"
              busy={disconnecting === account.id}
              onClick={() => void disconnect(account.id)}
            >
              Disconnect
            </Action>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Action tone="outline" busy={connecting} onClick={() => void connect()}>
          <Plus size={14} />
          Connect another account
        </Action>
        <span className="flex-1" />
        <Action tone="quiet" onClick={close}>
          Close
        </Action>
      </div>
    </div>
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
      <div className="flex items-center gap-3 rounded-lg bg-ink/5 px-3 py-2.5 text-xs text-muted">
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
    <div className="grid gap-2 rounded-lg bg-warn/10 px-3 py-2.5 text-xs leading-relaxed text-warn">
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

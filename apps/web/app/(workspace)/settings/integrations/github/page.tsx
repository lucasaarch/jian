'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button, Empty, GitHubLogo, ResourceRow, SectionHeading } from '@/components/ui';
import { githubOutcome } from '@/lib/github';
import { settingsPath } from '@/lib/navigation';
import { panelApi } from '@/lib/query/client';
import { keys } from '@/lib/query/keys';
import { useReportFailure } from '@/lib/query/notify';
import { queries } from '@/lib/query/profile';
import { notifyError } from '@/lib/workspace';

export default function GitHubIntegrationDetailsPage() {
  const api = panelApi();
  const client = useQueryClient();
  const { data: integration, isPending: loading } = useReportFailure(
    useQuery(queries.githubIntegration()),
    'GitHub App details could not load.',
  );
  const refresh = () => client.invalidateQueries({ queryKey: keys.githubIntegration });
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string>();

  // GitHub sends the owner back here with the outcome in the query; it is said once, then dropped.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = githubOutcome(params);
    if (outcome) {
      if (outcome.failed) toast.error(outcome.text, { duration: 12_000 });
      else toast.success(outcome.text);
      params.delete('github');
      params.delete('reason');
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }
  }, []);

  const connect = async () => {
    setConnecting(true);
    try {
      const result = await api.startGithubInstallation('/settings/integrations/github');
      window.location.assign(result.url);
    } catch (error) {
      notifyError(error, 'GitHub authorization could not start.');
      setConnecting(false);
    }
  };

  const disconnect = async (id: string) => {
    setDisconnecting(id);
    try {
      await api.disconnectGithubInstallation(id);
      await refresh();
      toast.success('GitHub installation disconnected from Jian.');
    } catch (error) {
      notifyError(error, 'GitHub installation could not be disconnected.');
    } finally {
      setDisconnecting(undefined);
    }
  };

  const app = integration?.app;
  const ownerPath =
    app?.ownerType === 'Organization' && app.ownerLogin
      ? `/organizations/${encodeURIComponent(app.ownerLogin)}/settings/apps/${encodeURIComponent(app.slug)}`
      : `/settings/apps/${encodeURIComponent(app?.slug ?? '')}`;
  const permissionUrl = `https://github.com${ownerPath}/permissions`;

  return (
    <>
      <Link href={settingsPath('integrations')} className="integration-back-link">
        <ArrowLeft size={16} /> Integrations
      </Link>
      <SectionHeading
        title={app?.name ?? 'GitHub App'}
        description="Official GitHub MCP tools for every agent: each connected account in any chat, and only its repository in a project's chat."
        action={
          <Button
            busy={connecting}
            disabled={!integration?.configured}
            onClick={() => void connect()}
          >
            Connect account
          </Button>
        }
      />

      {app && (
        <section className="github-app-details-card">
          <div className="integration-card-icon">
            <GitHubLogo size={24} />
          </div>
          <div className="github-app-details-copy">
            <strong>{app.name}</strong>
            <span>
              {app.ownerLogin ? `${app.ownerLogin} · ` : ''}App ID {app.appId}
            </span>
          </div>
          <a href={app.url} target="_blank" rel="noreferrer" className="integration-external-link">
            View App <ExternalLink size={14} />
          </a>
        </section>
      )}

      {integration?.configured && integration.permissionsVerified === false && (
        <div className="integration-permission-notice" role="status">
          Jian could not verify the App's GitHub permissions right now. Refresh this page after
          confirming GitHub is reachable.
        </div>
      )}
      {integration?.permissionsVerified && (integration.missingPermissions?.length ?? 0) > 0 && (
        <div className="integration-permission-notice" role="status">
          <div>
            <strong>Update the GitHub App permissions</strong>
            <p>
              This App predates the GitHub MCP access or is missing permissions. Grant the listed
              repository permissions in GitHub, then approve the change for each installation.
            </p>
            <p className="github-missing-permissions">
              Missing: {integration.missingPermissions?.join(', ')}
            </p>
          </div>
          <a
            href={permissionUrl}
            target="_blank"
            rel="noreferrer"
            className="integration-external-link"
          >
            Permissions & events <ExternalLink size={14} />
          </a>
        </div>
      )}

      <section className="github-installations">
        <SectionHeading
          title="Installations"
          description="GitHub accounts that have granted this App repository access."
        />
        {integration?.accounts.length ? (
          <div className="resource-list">
            {integration.accounts.map((account) => {
              const installationUrl =
                account.type === 'Organization'
                  ? `https://github.com/organizations/${encodeURIComponent(account.login)}/settings/installations/${account.installationId}`
                  : `https://github.com/settings/installations/${account.installationId}`;
              return (
                <ResourceRow
                  key={account.id}
                  id={`github-${account.id}`}
                  icon={<GitHubLogo size={20} />}
                  name={account.login}
                  description={
                    account.type === 'Organization'
                      ? 'Organization installation'
                      : 'Personal installation'
                  }
                  facts={[`Added ${new Date(account.connectedAt).toLocaleDateString('en')}`]}
                  actions={
                    <>
                      <a
                        href={installationUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="integration-external-link"
                      >
                        Review access <ExternalLink size={14} />
                      </a>
                      <Button
                        variant="quiet"
                        busy={disconnecting === account.id}
                        onClick={() => void disconnect(account.id)}
                      >
                        Disconnect
                      </Button>
                    </>
                  }
                />
              );
            })}
          </div>
        ) : (
          <Empty title={loading ? 'Loading GitHub App' : 'No installations yet'}>
            {loading
              ? 'Checking the shared GitHub App.'
              : 'Connect a GitHub account to choose repositories for Jian projects.'}
          </Empty>
        )}
      </section>
    </>
  );
}

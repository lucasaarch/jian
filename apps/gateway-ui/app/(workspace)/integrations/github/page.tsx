'use client';

import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, Empty, GitHubLogo, ResourceRow, SectionHeading } from '../../../../components/ui';
import type { GitHubIntegration } from '../../../../lib/api';
import { useSection, useWorkspace } from '../../../../lib/workspace';

type ReturnPath = '/integrations/github' | '/ui/integrations/github';

export default function GitHubIntegrationDetailsPage() {
  const { api } = useSection();
  const { setNotice } = useWorkspace();
  const [integration, setIntegration] = useState<GitHubIntegration>();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setIntegration(await api.githubIntegration());
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'GitHub App details could not load.',
        error: true,
      });
    } finally {
      setLoading(false);
    }
  }, [api, setNotice]);

  useEffect(() => {
    void refresh();
    const params = new URLSearchParams(window.location.search);
    const result = params.get('github');
    if (result) {
      setNotice({
        text: result === 'connected' ? 'GitHub account connected.' : 'GitHub authorization failed.',
        error: result !== 'connected',
      });
      params.delete('github');
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }
  }, [refresh, setNotice]);

  const connect = async () => {
    setConnecting(true);
    try {
      const returnPath: ReturnPath = window.location.pathname.startsWith('/ui/')
        ? '/ui/integrations/github'
        : '/integrations/github';
      const result = await api.startGithubInstallation(returnPath);
      window.location.assign(result.url);
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'GitHub authorization could not start.',
        error: true,
      });
      setConnecting(false);
    }
  };

  const disconnect = async (id: string) => {
    setDisconnecting(id);
    try {
      await api.disconnectGithubInstallation(id);
      await refresh();
      setNotice({ text: 'GitHub installation disconnected from Jian.', error: false });
    } catch (error) {
      setNotice({
        text:
          error instanceof Error ? error.message : 'GitHub installation could not be disconnected.',
        error: true,
      });
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
      <Link href="/integrations" className="integration-back-link">
        <ArrowLeft size={16} /> Integrations
      </Link>
      <SectionHeading
        title={app?.name ?? 'GitHub App'}
        description="Official GitHub MCP tools for the repositories linked to each Jian project."
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

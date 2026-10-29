'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Capabilities } from '../../../components/skills';
import { Button, GitHubLogo, SectionHeading } from '../../../components/ui';
import type { GitHubIntegration } from '../../../lib/api';
import { useSection, useWorkspace } from '../../../lib/workspace';

type IntegrationTab = 'apps' | 'mcps';
type GitHubReturnPath = '/integrations' | '/ui/integrations';

export default function IntegrationsPage() {
  const section = useSection();
  const { api } = section;
  const { profiles, setNotice } = useWorkspace();
  const [integration, setIntegration] = useState<GitHubIntegration>();
  const [tab, setTab] = useState<IntegrationTab>('apps');
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(
    () =>
      api
        .githubIntegration()
        .then(setIntegration)
        .catch((error: unknown) =>
          setNotice({
            text: error instanceof Error ? error.message : 'GitHub integration could not load.',
            error: true,
          }),
        )
        .finally(() => setLoading(false)),
    [api, setNotice],
  );

  useEffect(() => {
    void refresh();
    const params = new URLSearchParams(window.location.search);
    const requestedTab = params.get('tab');
    if (requestedTab === 'mcps') setTab('mcps');
    const result = params.get('github');
    if (result) {
      setNotice({
        text:
          result === 'connected'
            ? 'GitHub account connected.'
            : result === 'registered'
              ? 'GitHub App registered. Open its details to connect accounts.'
              : 'GitHub authorization did not complete. Try again.',
        error: result === 'failed',
      });
      params.delete('github');
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }
  }, [refresh, setNotice]);

  const selectTab = (next: IntegrationTab) => {
    setTab(next);
    const params = new URLSearchParams(window.location.search);
    if (next === 'mcps') params.set('tab', 'mcps');
    else params.delete('tab');
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  };

  const register = async () => {
    setConnecting(true);
    try {
      const returnPath: GitHubReturnPath = window.location.pathname.startsWith('/ui/')
        ? '/ui/integrations'
        : '/integrations';
      const { action, manifest } = await api.startGithubAppRegistration(returnPath);
      const form = document.createElement('form');
      form.method = 'post';
      form.action = action;
      form.target = '_blank';
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = JSON.stringify(manifest);
      form.append(input);
      document.body.append(form);
      form.submit();
      form.remove();
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'GitHub App registration could not start.',
        error: true,
      });
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <SectionHeading
        title="Integrations"
        description="Connect official services and MCP servers for your agents."
      />
      <div className="integration-tabs" role="tablist" aria-label="Integration types">
        <button
          type="button"
          id="integrations-apps-tab"
          role="tab"
          aria-selected={tab === 'apps'}
          aria-controls="integrations-apps-panel"
          onClick={() => selectTab('apps')}
        >
          Apps
        </button>
        <button
          type="button"
          id="integrations-mcps-tab"
          role="tab"
          aria-selected={tab === 'mcps'}
          aria-controls="integrations-mcps-panel"
          onClick={() => selectTab('mcps')}
        >
          MCPs
        </button>
      </div>

      {tab === 'apps' ? (
        <section
          id="integrations-apps-panel"
          role="tabpanel"
          aria-labelledby="integrations-apps-tab"
        >
          {integration?.configured && integration.app ? (
            <Link href="/integrations/github" className="integration-app-card">
              <span className="integration-card-icon">
                <GitHubLogo size={24} />
              </span>
              <span className="integration-app-card-copy">
                <strong>{integration.app.name}</strong>
                <span>GitHub App · {integration.app.ownerLogin ?? integration.app.slug}</span>
              </span>
              <span className="integration-app-card-action">Details</span>
            </Link>
          ) : (
            <article className="integration-app-card integration-app-card-unconfigured">
              <span className="integration-card-icon">
                <GitHubLogo size={24} />
              </span>
              <span className="integration-app-card-copy">
                <strong>GitHub</strong>
                <span>
                  {loading
                    ? 'Checking the GitHub App registration.'
                    : 'Create Jian’s GitHub App to give agents repository tools.'}
                </span>
              </span>
              <Button
                busy={connecting}
                disabled={loading || !integration?.callbackUrl}
                onClick={() => void register()}
              >
                Create App
              </Button>
            </article>
          )}
          {!loading && !integration?.callbackUrl && (
            <p className="integration-public-url-note">
              Set <code>JIAN_PUBLIC_URL</code> to the public HTTPS address of this Jian gateway
              before registering an App.
            </p>
          )}
        </section>
      ) : (
        <section
          id="integrations-mcps-panel"
          role="tabpanel"
          aria-labelledby="integrations-mcps-tab"
        >
          <p className="integration-mcp-note">
            GitHub MCP tools are added automatically to chats with a GitHub-backed project and are
            scoped to that project’s repository.
          </p>
          <Capabilities {...section} kind="mcpServers" others={profiles} />
        </section>
      )}
    </>
  );
}

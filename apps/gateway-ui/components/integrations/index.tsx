'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button, GitHubLogo, SectionHeading } from '@/components/ui';
import { githubOutcome } from '@/lib/github';
import { settingsPath } from '@/lib/navigation';
import { useReportFailure } from '@/lib/query/notify';
import { queries } from '@/lib/query/profile';
import { notifyError, useActions } from '@/lib/workspace';
import { McpServers } from './mcp-servers';

/** Each tab is a route of its own, so a link or a reload opens the one it names. */
export type IntegrationTab = 'apps' | 'mcps';

export function Integrations({ tab }: { tab: IntegrationTab }) {
  const actions = useActions();
  const { api } = actions;
  const { data: integration, isPending: loading } = useReportFailure(
    useQuery(queries.githubIntegration()),
    'GitHub integration could not load.',
  );
  const [connecting, setConnecting] = useState(false);

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

  const register = async () => {
    setConnecting(true);
    try {
      const { action, manifest } = await api.startGithubAppRegistration('/settings/integrations');
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
      notifyError(error, 'GitHub App registration could not start.');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <SectionHeading
        title="Integrations"
        description="Official services and MCP servers, shared by every agent."
      />
      <div className="integration-tabs" role="tablist" aria-label="Integration types">
        <Link
          href={settingsPath('integrations')}
          replace
          id="integrations-apps-tab"
          role="tab"
          aria-selected={tab === 'apps'}
          aria-controls={tab === 'apps' ? 'integrations-apps-panel' : undefined}
        >
          Apps
        </Link>
        <Link
          href={settingsPath('integrations/mcps')}
          replace
          id="integrations-mcps-tab"
          role="tab"
          aria-selected={tab === 'mcps'}
          aria-controls={tab === 'mcps' ? 'integrations-mcps-panel' : undefined}
        >
          MCPs
        </Link>
      </div>

      {tab === 'apps' ? (
        <section
          id="integrations-apps-panel"
          role="tabpanel"
          aria-labelledby="integrations-apps-tab"
        >
          {integration?.configured && integration.app ? (
            <Link href={settingsPath('integrations/github')} className="integration-app-card">
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
            GitHub’s MCP tools are added to every chat once an account is connected under Apps; a
            chat in a GitHub-backed project reaches only that project’s repository.
          </p>
          <McpServers {...actions} />
        </section>
      )}
    </>
  );
}

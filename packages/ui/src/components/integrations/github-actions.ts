'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { notifyError } from '../../lib/workspace';

export type GithubIntegration = Awaited<ReturnType<GatewayApi['githubIntegration']>>;
type GithubApp = NonNullable<GithubIntegration['app']>;
type GithubAccount = GithubIntegration['accounts'][number];

/** Where GitHub lets the App's owner grant the permissions it is missing. */
export function appPermissionsUrl(app: GithubApp): string {
  const ownerPath =
    app.ownerType === 'Organization' && app.ownerLogin
      ? `/organizations/${encodeURIComponent(app.ownerLogin)}/settings/apps/${encodeURIComponent(app.slug)}`
      : `/settings/apps/${encodeURIComponent(app.slug)}`;

  return `https://github.com${ownerPath}/permissions`;
}

/** Where GitHub shows the repositories one installation reaches. */
export function installationUrl(account: GithubAccount): string {
  return account.type === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(account.login)}/settings/installations/${account.installationId}`
    : `https://github.com/settings/installations/${account.installationId}`;
}

/**
 * GitHub's pages happen outside the panel: in this tab, in a new one, or in the system's browser
 * when a desktop host keeps its window. Once the window is back in front, what GitHub changed is
 * read again, since no event of the gateway says so, and `settle` ends the wait.
 */
function useReturnFromGithub(settle: () => void) {
  const client = useQueryClient();
  const away = useRef(false);
  const settled = useRef(settle);
  settled.current = settle;

  useEffect(() => {
    const back = () => {
      if (!away.current) return;
      away.current = false;
      settled.current();
      void client.invalidateQueries({ queryKey: keys.githubIntegration });
    };
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [client]);

  return () => {
    away.current = true;
  };
}

/**
 * Registers Jian's GitHub App from its manifest. GitHub takes the manifest only as a form posted
 * to it, so one is built and posted to a new tab, where the owner confirms the App's name.
 */
export function useGithubRegistration(api: GatewayApi) {
  const [registering, setRegistering] = useState(false);
  const leave = useReturnFromGithub(() => undefined);

  const register = async () => {
    setRegistering(true);
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
      leave();
      form.submit();
      form.remove();
    } catch (error) {
      notifyError(error, 'GitHub App registration could not start.');
    } finally {
      setRegistering(false);
    }
  };

  return { registering, register };
}

/**
 * Connects a GitHub account to the registered App, and lets one go. Connecting leaves for GitHub;
 * it stays busy until the panel is left, or, where the host opened GitHub elsewhere, until the
 * window is back in front.
 */
export function useGithubInstallations(api: GatewayApi) {
  const client = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string>();
  const leave = useReturnFromGithub(() => setConnecting(false));

  const connect = async () => {
    setConnecting(true);
    try {
      const result = await api.startGithubInstallation('/settings/integrations/github');
      leave();
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
      await client.invalidateQueries({ queryKey: keys.githubIntegration });
      toast.success('GitHub installation disconnected from Jian.');
    } catch (error) {
      notifyError(error, 'GitHub installation could not be disconnected.');
    } finally {
      setDisconnecting(undefined);
    }
  };

  return { connecting, connect, disconnecting, disconnect };
}

import type { Client } from './params';
import { result } from './result';

export const integrationCalls = (client: Client) => ({
  githubIntegration: () => result(client.GET('/v1/integrations/github')),
  startGithubInstallation: (
    returnPath:
      | '/integrations'
      | '/ui/integrations'
      | '/integrations/github'
      | '/ui/integrations/github',
  ) => result(client.POST('/v1/integrations/github/install', { body: { returnPath } })),
  startGithubAppRegistration: (
    returnPath:
      | '/integrations'
      | '/ui/integrations'
      | '/integrations/github'
      | '/ui/integrations/github',
  ) => result(client.POST('/v1/integrations/github/manifest', { body: { returnPath } })),
  githubRepositories: (accountId: string) =>
    result(
      client.GET('/v1/integrations/github/installations/{accountId}/repositories', {
        params: { path: { accountId } },
      }),
    ),
  disconnectGithubInstallation: (accountId: string) =>
    result(
      client.DELETE('/v1/integrations/github/installations/{accountId}', {
        params: { path: { accountId } },
      }),
    ),
});

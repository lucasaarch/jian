import type { Client } from './params';
import { result } from './result';
import type { McpServer } from './types';

export const integrationCalls = (client: Client) => ({
  githubIntegration: () => result(client.GET('/v1/integrations/github')),
  startGithubInstallation: (
    // The Integrations page that started it; the gateway sends the owner back there.
    returnPath: GithubReturnPath,
  ) => result(client.POST('/v1/integrations/github/install', { body: { returnPath } })),
  startGithubAppRegistration: (
    // The Integrations page that started it; the gateway sends the owner back there.
    returnPath: GithubReturnPath,
  ) => result(client.POST('/v1/integrations/github/manifest', { body: { returnPath } })),
  // Every connected account's, in one list; each item names the account it comes through.
  githubRepositories: () => result(client.GET('/v1/integrations/github/repositories')),
  disconnectGithubInstallation: (accountId: string) =>
    result(
      client.DELETE('/v1/integrations/github/installations/{accountId}', {
        params: { path: { accountId } },
      }),
    ),
  mcpServers: () => result(client.GET('/v1/mcp-servers')),
  // The whole list at once: a value left out of a header keeps the stored one.
  replaceMcpServers: (servers: McpServer[]) =>
    result(client.PUT('/v1/mcp-servers', { body: { servers } })),
  // A server the form holds and has not saved; nothing it carries is stored.
  checkMcpDraft: (server: McpServer) =>
    result(client.POST('/v1/mcp-servers/check', { body: { server } })),
  checkMcpServer: (name: string) =>
    result(client.POST('/v1/mcp-servers/{name}/check', { params: { path: { name } } })),
});

type GithubReturnPath = '/settings/integrations' | '/settings/integrations/github';

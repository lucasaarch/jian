import type { Client } from './params';
import { result } from './result';
import type { GitHubMergeMethod, McpServer } from './types';

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
  // Read as the installation on the repository's account; one it cannot see is a 404.
  githubPull: (owner: string, repo: string, number: number) =>
    result(
      client.GET('/v1/integrations/github/pulls/{owner}/{repo}/{number}', {
        params: { path: { owner, repo, number } },
      }),
    ),
  githubIssue: (owner: string, repo: string, number: number) =>
    result(
      client.GET('/v1/integrations/github/issues/{owner}/{repo}/{number}', {
        params: { path: { owner, repo, number } },
      }),
    ),
  // At most 20 at a time; each answers in order, unreachable when the App cannot see it.
  resolveGithubLinks: (urls: string[]) =>
    result(client.POST('/v1/integrations/github/links', { body: { urls } })),
  // The head the owner saw goes with it: GitHub refuses if the branch moved since.
  mergeGithubPull: (
    owner: string,
    repo: string,
    number: number,
    body: { method: GitHubMergeMethod; expectedHeadSha: string; profileId?: string },
  ) =>
    result(
      client.POST('/v1/integrations/github/pulls/{owner}/{repo}/{number}/merge', {
        params: { path: { owner, repo, number } },
        body,
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

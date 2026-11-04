import type { McpServer } from '@jian/contracts';
import { mcpValueSecret } from './mcp-connect.js';

/**
 * The server acts as the Jian GitHub App, and GitHub keeps a person's own data from an App's
 * installation token: stars and "who am I" answer 403 whatever the App's permissions. Their
 * toolset is left out, and `get_me` switched off, so the agent never plans around them.
 */
export const GITHUB_MCP_TOOLSETS =
  'default,actions,code_security,dependabot,discussions,git,labels,secret_protection,security_advisories';
const USER_ONLY_TOOLS = ['get_me'];

const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';

/**
 * Arguments of GitHub's tools the agent is never shown. Models fill in optional arguments they
 * have no use for, and a number that has a minimum gets that minimum: `issue_write` called with
 * `parent_issue_number: 1` tries to attach the new issue under issue #1, and the whole create
 * fails with "failed to resolve parent issue" wherever #1 is missing. A parent is still set with
 * `sub_issue_write`, which the agent calls only when it means to.
 */
const HIDDEN_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  issue_write: ['parent_issue_number', 'parent_owner', 'parent_repo'],
};

/** What a tool of this server hides from the agent; GitHub's server alone hides anything. */
export const hiddenArguments = (server: McpServer, tool: string): readonly string[] =>
  (server.url === GITHUB_MCP_URL && HIDDEN_ARGUMENTS[tool]) || [];

/**
 * The server the GitHub integration attaches to a run. The toolsets header is what tells it
 * apart from one the owner configured by hand, which signs in with OAuth instead.
 */
export const isGitHubIntegrationServer = (server: McpServer) =>
  server.url === GITHUB_MCP_URL &&
  server.headers.some((header) => header.name === 'X-MCP-Toolsets');

/**
 * `github`, or `github_<login>` when several accounts are attached, so the agent can tell them
 * apart; never a name the profile already gives one of its own servers.
 */
export function githubMcpServerName(login: string | undefined, taken: ReadonlySet<string>) {
  const base = login
    ? `github_${login.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`.slice(0, 26)
    : 'github';
  let name = base;
  for (let suffix = 2; taken.has(name); suffix++) name = `${base}_${suffix}`;
  return name;
}

export function githubMcpServer(name: string): McpServer {
  return {
    name,
    transport: 'http',
    url: GITHUB_MCP_URL,
    auth: 'headers',
    headers: [{ name: 'Authorization' }, { name: 'X-MCP-Toolsets' }],
    args: [],
    env: [],
    disabledTools: USER_ONLY_TOOLS,
  };
}

export const githubMcpCredentialKey = (server: string) =>
  mcpValueSecret(server, 'header', 'Authorization');

export const githubMcpToolsetsKey = (server: string) =>
  mcpValueSecret(server, 'header', 'X-MCP-Toolsets');

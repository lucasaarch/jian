import type { McpServer } from '@jian/contracts';
import { mcpValueSecret } from './mcp-connect.js';

export const GITHUB_MCP_TOOLSETS =
  'default,actions,code_security,dependabot,discussions,git,labels,secret_protection,security_advisories,stargazers';

const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';

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
    disabledTools: [],
  };
}

export const githubMcpCredentialKey = (server: string) =>
  mcpValueSecret(server, 'header', 'Authorization');

export const githubMcpToolsetsKey = (server: string) =>
  mcpValueSecret(server, 'header', 'X-MCP-Toolsets');

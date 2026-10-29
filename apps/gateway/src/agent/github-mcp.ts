import type { McpServer } from '@jian/contracts';
import { mcpValueSecret } from './mcp-connect.js';

export const GITHUB_MCP_TOOLSETS =
  'default,actions,code_security,dependabot,discussions,git,labels,secret_protection,security_advisories,stargazers';

export function githubMcpServer(name: string): McpServer {
  return {
    name,
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
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

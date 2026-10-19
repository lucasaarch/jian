import type { McpServer } from '../../lib/api';

/**
 * Starter configs for common MCP servers. Values still need the owner's credentials —
 * OAuth after save, or a PAT in the env/header fields.
 */
export const mcpPresets: {
  id: string;
  label: string;
  hint: string;
  server: McpServer;
}[] = [
  {
    id: 'github-http',
    label: 'GitHub (HTTP + OAuth)',
    hint: 'Official remote MCP. After save, use Test the connection to sign in. Needs JIAN_PUBLIC_URL.',
    server: {
      name: 'github',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      auth: 'oauth',
      headers: [],
      args: [],
      env: [],
    },
  },
  {
    id: 'github-stdio',
    label: 'GitHub (stdio + PAT)',
    hint: 'Runs @modelcontextprotocol/server-github on this machine. Set GITHUB_PERSONAL_ACCESS_TOKEN.',
    server: {
      name: 'github',
      transport: 'stdio',
      auth: 'none',
      headers: [],
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '' }],
    },
  },
];

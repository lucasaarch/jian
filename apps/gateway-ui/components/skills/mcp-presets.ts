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
    hint: 'Official remote MCP. After save, use Test the connection to sign in. Needs JIAN_PUBLIC_URL. Best validation error detail.',
    server: {
      name: 'github',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      auth: 'oauth',
      headers: [],
      args: [],
      env: [],
      disabledTools: [],
    },
  },
  {
    id: 'github-stdio-docker',
    label: 'GitHub (Docker + PAT)',
    hint: 'Official ghcr.io/github/github-mcp-server. Set GITHUB_PERSONAL_ACCESS_TOKEN. Surfaces full 422 validation fields.',
    server: {
      name: 'github',
      transport: 'stdio',
      auth: 'none',
      headers: [],
      command: 'docker',
      args: [
        'run',
        '-i',
        '--rm',
        '-e',
        'GITHUB_PERSONAL_ACCESS_TOKEN',
        'ghcr.io/github/github-mcp-server',
      ],
      env: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '' }],
      disabledTools: [],
    },
  },
  {
    id: 'github-stdio',
    label: 'GitHub (npx + PAT, archived)',
    hint: 'Deprecated @modelcontextprotocol/server-github. create_issue may return only "Validation Failed" without errors[]. Prefer HTTP+OAuth or Docker+PAT.',
    server: {
      name: 'github',
      transport: 'stdio',
      auth: 'none',
      headers: [],
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: [{ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '' }],
      disabledTools: [],
    },
  },
];

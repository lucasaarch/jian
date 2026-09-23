import { describe, expect, it } from 'vitest';
import { availableNote, type McpEntry, searchCatalog } from '../src/agent/mcp.js';

const entry = (server: string, tool: string, description = ''): McpEntry => ({
  name: `mcp__${server}_${tool}_00000000`,
  server,
  tool,
  description,
});

const catalog = [
  entry('github', 'list_pull_requests', 'List pull requests in a repository'),
  entry('github', 'createIssue', 'Open a new issue in a repository'),
  entry('github', 'search_code', 'Search code across repositories'),
  entry('gmail', 'send_message', 'Send an email from the connected mailbox'),
  entry('gmail', 'list_labels'),
];

describe('finding a connected MCP tool', () => {
  it('finds a tool by the words a model asks with, not only its exact name', () => {
    expect(searchCatalog(catalog, 'create issue')[0]?.tool).toBe('createIssue');
    expect(searchCatalog(catalog, 'send email')[0]?.tool).toBe('send_message');
    expect(searchCatalog(catalog, 'pull request')[0]?.tool).toBe('list_pull_requests');
  });

  it('lists a whole server when asked for it by name', () => {
    expect(searchCatalog(catalog, '', 'gmail').map((item) => item.tool)).toEqual([
      'send_message',
      'list_labels',
    ]);
    expect(searchCatalog(catalog, 'github').map((item) => item.server)).toEqual([
      'github',
      'github',
      'github',
    ]);
  });

  it('answers nothing rather than something unrelated', () => {
    expect(searchCatalog(catalog, 'calendar event')).toEqual([]);
  });

  it('tells the agent in its prompt which servers and tools it has', () => {
    const note = availableNote(catalog);

    expect(note).toContain('github (3 tools): list_pull_requests, createIssue, search_code');
    expect(note).toContain('gmail (2 tools)');
    expect(note).toContain('search_mcp_tools');
    expect(availableNote([])).toBe('');
  });
});

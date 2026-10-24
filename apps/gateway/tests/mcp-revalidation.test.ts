import assert from 'node:assert/strict';
import type { MCPClient } from '@ai-sdk/mcp';
import type { McpServer, Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { availableNote, connectMcpTools } from '../src/agent/mcp.js';
import { connectMcp } from '../src/agent/mcp-connect.js';

vi.mock('../src/agent/mcp-connect.js', () => ({ connectMcp: vi.fn() }));

const servers = [
  { name: 'docs', transport: 'http', url: 'https://docs.example/mcp' },
  { name: 'mail', transport: 'http', url: 'https://mail.example/mcp' },
] as McpServer[];
const denied = new Set<string>();
const authorize = vi.fn(async (server: McpServer, name?: string) => {
  if (denied.has(server.name) || denied.has(`${server.name}.${name}`)) {
    throw new Error('Revoked');
  }
});
const remoteExecute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));

beforeEach(() => {
  denied.clear();
  vi.clearAllMocks();
  vi.mocked(connectMcp).mockImplementation(async ({ server }) => {
    const names = server.name === 'docs' ? ['search', 'read_doc'] : ['search', 'send_email'];
    return {
      tools: async () =>
        Object.fromEntries(
          names.map((name) => [
            name,
            tool({
              description: `Private description of ${server.name}.${name}`,
              inputSchema: z.object({}),
              execute: remoteExecute,
            }),
          ]),
        ),
      close: vi.fn(async () => {}),
    } as unknown as MCPClient;
  });
});

async function setup(legacy = false) {
  const tools: ToolSet = {};
  const run = {
    profileId: 'p',
    profile: { professionId: null, mcpServers: servers },
  } as unknown as Run;
  const mcp = await connectMcpTools(run, tools, {
    vault: undefined,
    secrets: new Set(),
    clients: [],
    fetcher: globalThis.fetch,
    signal: new AbortController().signal,
    ...(legacy ? {} : { authorize }),
  });
  const call = async (name: string, input: unknown) => {
    const execute = tools[name]?.execute;
    if (!execute) throw new Error(`Missing execute: ${name}`);
    return execute(input as never, { toolCallId: 'test', messages: [], context: undefined });
  };
  return { ...mcp, tools, call };
}

it('authorizes each real server/tool pair before initially presenting the catalog', async () => {
  denied.add('docs.read_doc');
  const mcp = await setup();
  expect(mcp.catalog.map((entry) => `${entry.server}.${entry.tool}`)).toEqual([
    'docs.search',
    'mail.search',
    'mail.send_email',
  ]);
  expect(mcp.tools.load_mcp_tools?.description).not.toContain('read_doc');
  expect(availableNote(mcp.catalog)).not.toContain('read_doc');
  expect(authorize).toHaveBeenCalledWith(servers[0], 'read_doc');
});

it.each(['exposed', 'qualified', 'bare'])(
  'rejects a revoked %s alias without partially selecting the batch',
  async (alias) => {
    const mcp = await setup();
    const entry = mcp.catalog.find((entry) => entry.tool === 'read_doc');
    assert.ok(entry);
    const name =
      alias === 'exposed' ? entry.name : alias === 'qualified' ? 'docs.read_doc' : 'read_doc';
    denied.add('docs.read_doc');
    authorize.mockClear();
    await expect(mcp.call('load_mcp_tools', { names: ['mail.send_email', name] })).rejects.toThrow(
      'no longer authorized',
    );
    expect(authorize).toHaveBeenCalledWith(servers[0], 'read_doc');
    expect(mcp.selectedMcpTools.size).toBe(0);
    expect(mcp.catalog.some((entry) => entry.tool === 'read_doc')).toBe(false);
  },
);

it('accepts all aliases, but does not reinterpret an ambiguous bare alias after revocation', async () => {
  const mcp = await setup();
  const entry = mcp.catalog.find((entry) => entry.tool === 'read_doc');
  assert.ok(entry);
  await mcp.call('load_mcp_tools', { names: [entry.name, 'docs.read_doc', 'read_doc'] });
  expect([...mcp.selectedMcpTools]).toEqual([entry.name]);
  denied.add('docs');
  await expect(mcp.call('load_mcp_tools', { names: ['search'] })).rejects.toThrow(
    'No connected MCP server offers search',
  );
  expect(mcp.selectedMcpTools.has(entry.name)).toBe(true);
  await mcp.revalidateMcpTools();
  expect(mcp.selectedMcpTools.size).toBe(0);
});

it('filters revoked entries from search and its hints while another server retains the same transport', async () => {
  const mcp = await setup();
  denied.add('docs');
  authorize.mockClear();
  const result = await mcp.call('search_mcp_tools', { query: '' });
  expect(result).toMatchObject({
    results: [
      { server: 'mail', tool: 'search' },
      { server: 'mail', tool: 'send_email' },
    ],
  });
  expect(authorize).toHaveBeenCalledWith(servers[0], 'search');
  expect(authorize).toHaveBeenCalledWith(servers[1], 'search');
  expect(await mcp.call('search_mcp_tools', { query: '', server: 'docs' })).toMatchObject({
    results: [],
  });
  const miss = await mcp.call('search_mcp_tools', { query: 'unmatched' });
  expect(JSON.stringify(miss)).not.toContain('docs');
});

it('prepareStep hook removes already selected schemas without a discovery call and preserves execute revalidation', async () => {
  const mcp = await setup();
  await mcp.call('load_mcp_tools', { names: ['docs.search', 'mail.search', 'read_doc'] });
  const docsSearch = mcp.catalog.find(
    (entry) => entry.server === 'docs' && entry.tool === 'search',
  )?.name;
  const readDoc = mcp.catalog.find((entry) => entry.tool === 'read_doc')?.name;
  const mailSearch = mcp.catalog.find(
    (entry) => entry.server === 'mail' && entry.tool === 'search',
  )?.name;
  assert.ok(docsSearch);
  assert.ok(readDoc);
  assert.ok(mailSearch);
  const catalogReference = mcp.catalog;
  const selectionReference = mcp.selectedMcpTools;
  // Like runtime's guarded ToolSet, this retains schemas that were wrapped before revocation.
  const guarded = { ...mcp.tools };
  denied.add('docs');
  await mcp.revalidateMcpTools();
  expect(mcp.catalog).toBe(catalogReference);
  expect(mcp.selectedMcpTools).toBe(selectionReference);
  expect(mcp.selectedMcpTools.has(docsSearch)).toBe(false);
  expect(mcp.selectedMcpTools.has(readDoc)).toBe(false);
  expect(mcp.selectedMcpTools.has(mailSearch)).toBe(true);
  const active = Object.keys(guarded).filter((name) =>
    mcp.mcpToolNames.includes(name) ? mcp.selectedMcpTools.has(name) : true,
  );
  expect(active).not.toContain(docsSearch);
  expect(active).not.toContain(readDoc);
  expect(active).toContain(mailSearch);
  expect(availableNote(mcp.catalog)).not.toContain('docs');
  // Even an old execution reference cannot bypass revocation.
  await expect(mcp.call(docsSearch, {})).rejects.toThrow('Revoked');
  expect(remoteExecute).not.toHaveBeenCalled();
  await mcp.call(mailSearch, {});
  expect(remoteExecute).toHaveBeenCalledTimes(1);
});

it('prunes only a revoked tool while retaining other selections on both HTTP servers', async () => {
  const mcp = await setup();
  await mcp.call('load_mcp_tools', { names: ['docs.search', 'read_doc', 'mail.search'] });
  denied.add('docs.read_doc');
  await mcp.revalidateMcpTools();
  expect(mcp.selectedMcpTools.size).toBe(2);
  expect(mcp.catalog.map((entry) => `${entry.server}.${entry.tool}`)).toEqual([
    'docs.search',
    'mail.search',
    'mail.send_email',
  ]);
  expect(await mcp.call('search_mcp_tools', { query: '', server: 'docs' })).toMatchObject({
    results: [{ tool: 'search' }],
  });
});

it('preserves legacy catalog, selection and execution when authorize is absent', async () => {
  const mcp = await setup(true);
  const entry = mcp.catalog.find((entry) => entry.tool === 'read_doc');
  assert.ok(entry);
  denied.add('docs');
  await mcp.call('load_mcp_tools', { names: ['read_doc'] });
  await mcp.revalidateMcpTools();
  expect(mcp.catalog).toHaveLength(4);
  expect(mcp.selectedMcpTools.has(entry.name)).toBe(true);
  expect(await mcp.call('search_mcp_tools', { query: '', server: 'docs' })).toMatchObject({
    results: [{ tool: 'search' }, { tool: 'read_doc' }],
  });
  await mcp.call(entry.name, {});
  expect(remoteExecute).toHaveBeenCalledTimes(1);
  expect(authorize).not.toHaveBeenCalled();
});

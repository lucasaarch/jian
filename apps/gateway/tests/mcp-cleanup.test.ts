import type { MCPClient } from '@ai-sdk/mcp';
import type { Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { connectMcpTools } from '../src/agent/mcp.js';
import { connectMcp } from '../src/agent/mcp-connect.js';
import { mcpOutcomeUncertain } from '../src/agent/mcp-errors.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { runs } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

vi.mock('../src/agent/mcp-connect.js', () => ({ connectMcp: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const servers = [{ name: 'docs', transport: 'http' as const, url: 'https://docs.example/mcp' }];
const disconnected = () => new Error('Attempted to send a request from a closed client');
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const result = { content: [{ type: 'text', text: 'Saved' }] };
function client(execute = vi.fn(async () => result)) {
  const tools = vi.fn(async () => ({
    send_email: tool({ description: 'Send mail', inputSchema: z.object({}), execute }),
  }));
  const close = vi.fn(async () => {});
  return { value: { tools, close } as unknown as MCPClient, tools, close, execute };
}
async function discover() {
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  const discovered = await connectMcpTools(
    {
      profileId: 'p',
      profile: { professionId: null, mcpServers: servers },
    } as unknown as Run,
    tools,
    {
      clients,
      vault: undefined,
      secrets: new Set(),
      fetcher: globalThis.fetch,
      signal: new AbortController().signal,
    },
  );
  return { ...discovered, clients, tools };
}

it('retains a connected client when tools() fails, so the owner can close it', async () => {
  const opened = client();
  opened.tools.mockRejectedValue(new Error('list failed'));
  vi.mocked(connectMcp).mockResolvedValue(opened.value);
  const discovered = await discover();
  expect(discovered.unavailable).toEqual([{ name: 'docs', reason: 'list failed' }]);
  expect(discovered.clients).toEqual([opened.value]);
  await Promise.all(discovered.clients.map((entry) => entry.close()));
  expect(opened.close).toHaveBeenCalledTimes(1);
});

it('keeps both receipts and reports a previous-client close failure during reconnect', async () => {
  const previous = client(
    vi.fn(async () => {
      throw disconnected();
    }),
  );
  const reopened = client();
  previous.close.mockRejectedValue(new Error('close failed'));
  vi.mocked(connectMcp).mockResolvedValueOnce(previous.value).mockResolvedValueOnce(reopened.value);
  const discovered = await discover();
  expect(discovered.clients).toEqual([previous.value]); // No duplicate discovery registration.
  const name = discovered.mcpToolNames[0];
  const execute = name && discovered.tools[name]?.execute;
  if (!execute) throw new Error('missing tool');
  const error = await execute({}, { toolCallId: 'one', messages: [], context: undefined }).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('close failed');
  expect(mcpOutcomeUncertain(error)).toBe(false); // The replacement never sent a call.
  expect(discovered.clients).toEqual([previous.value, reopened.value]);
  expect(reopened.execute).not.toHaveBeenCalled();
  const closed = await Promise.allSettled(discovered.clients.map((entry) => entry.close()));
  expect(closed.map((entry) => entry.status)).toEqual(['rejected', 'fulfilled']);
  expect(previous.close).toHaveBeenCalledTimes(2);
  expect(reopened.close).toHaveBeenCalledTimes(1);
});

it.each([
  'success',
  'pre-send',
  'unknown-reconnect',
  'close-failure',
  'list-failure',
  'unknown-effect',
] as const)('runtime settles only fully accounted MCP work: %s', async (mode) => {
  const services = await testServices();
  // Tool errors can legitimately queue a separate learning run. Isolate this execution's
  // cleanup evidence, rather than asking reset to discard that new queued work.
  vi.spyOn(services.learning, 'consider').mockResolvedValue(undefined);
  const profile = await services.profiles.createProfile({
    name: 'MCP',
    instructions: 'Help.',
    mcpServers: servers,
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, {});
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Send mail',
    requestKey: 'one',
  });
  const opened = client(
    vi.fn(async () => {
      if (mode === 'pre-send' || mode === 'unknown-reconnect' || mode === 'close-failure')
        throw disconnected();
      if (mode === 'unknown-effect') throw new Error('Connection closed');
      return result;
    }),
  );
  const reopened = client();
  if (mode === 'close-failure') opened.close.mockRejectedValue(new Error('close failed'));
  if (mode === 'list-failure') opened.tools.mockRejectedValue(new Error('list failed'));
  vi.mocked(connectMcp).mockResolvedValue(opened.value);
  if (mode === 'pre-send') {
    const third = client(
      vi.fn(async () => {
        throw disconnected();
      }),
    );
    reopened.execute.mockRejectedValue(disconnected());
    vi.mocked(connectMcp)
      .mockResolvedValueOnce(opened.value)
      .mockResolvedValueOnce(reopened.value)
      .mockResolvedValueOnce(third.value);
  }
  if (mode === 'unknown-reconnect') {
    vi.mocked(connectMcp)
      .mockResolvedValueOnce(opened.value)
      .mockRejectedValue(new Error('initialization failed without a receipt'));
  }
  if (mode === 'close-failure') {
    vi.mocked(connectMcp).mockResolvedValueOnce(opened.value).mockResolvedValueOnce(reopened.value);
  }
  let step = 0;
  const model = mockModel({
    doGenerate: async (options) => {
      const phase = step++;
      const name =
        phase === 0
          ? 'load_mcp_tools'
          : options.tools?.find(
              (entry) =>
                entry.type === 'function' && entry.name.startsWith('mcp__docs_send_email_'),
            )?.name;
      if (mode !== 'list-failure' && phase < 2 && name)
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: `call-${phase}`,
              toolName: name,
              input: phase === 0 ? JSON.stringify({ names: ['send_email'] }) : '{}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      return {
        content: [{ type: 'text', text: 'Done.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      };
    },
  });
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  const stored = (await services.store.db.select().from(runs).where(eq(runs.id, run.id)))[0];
  expect(stored?.status).toBe(mode === 'unknown-effect' ? 'interrupted' : 'completed');
  expect(opened.close).toHaveBeenCalled();
  if (mode === 'success' || mode === 'pre-send') {
    expect(opened.execute).toHaveBeenCalled();
    expect(stored?.executionOwner).toBeNull();
    await services.profiles.resetProfile(profile.id);
    await services.profiles.deleteProfile(profile.id);
  } else {
    expect(stored?.executionOwner).toBeTruthy();
  }
  if (mode === 'close-failure') {
    expect(reopened.close).toHaveBeenCalledTimes(1);
    expect(reopened.execute).not.toHaveBeenCalled();
    expect(opened.close).toHaveBeenCalledTimes(2);
  }
});

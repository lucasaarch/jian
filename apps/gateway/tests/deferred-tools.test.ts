import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tool } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRuntime } from '../src/agent/runtime.js';
import { TOOL_GROUPS } from '../src/agent/tools.js';
import { createSafeFetch } from '../src/security/outbound.js';
import {
  type ClaudeReply,
  type ClaudeRequest,
  fakeClaude,
  referencedIn,
  resultOf,
  sentTools,
} from './helpers/claude.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const CONVERSATIONS = TOOL_GROUPS.conversations.tools;

async function conversation(
  model: { provider: string; modelId: string },
  contextPolicy?: Record<string, number>,
) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { ...model, apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    ...(contextPolicy ? { contextPolicy } : {}),
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Tools' });
  const ask = (text: string) =>
    services.runs.submit(profile.id, session.id, { text, requestKey: randomUUID() });
  return { services, profile, session, ask };
}

/** The turn's own steps: summaries and other side calls are sent without streaming. */
const steps = (requests: ClaudeRequest[]) => requests.filter((request) => request.stream);

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const call = (toolName: string, input: unknown = {}, id = `call-${toolName}`) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
  usage,
  warnings: [],
});

const answer = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});

describe('tool loading on Claude', () => {
  it.each(['claude-opus-5-5', 'claude-sonnet-4-5-20250929'])(
    'keeps the tools sent to Claude the same when the agent loads more (%s)',
    async (modelId) => {
      const { services, profile, ask } = await conversation({ provider: 'anthropic', modelId });
      const run = await ask('What else are we talking about?');
      const plan: ClaudeReply[] = [
        { tool: 'load_tools', input: { groups: ['conversations'] } },
        { tool: 'list_sessions' },
        { text: 'Only this one.' },
      ];
      const claude = fakeClaude(modelId, (request, index) =>
        request.stream ? (plan[index] ?? { text: 'Done.' }) : { text: 'Done.' },
      );

      await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

      const finished = await services.runs.run(profile.id, run.id);
      expect(finished.error).toBeUndefined();
      expect(finished.output).toBe('Only this one.');
      const sent = steps(claude.requests);
      expect(sent).toHaveLength(3);
      const [first, second, third] = sent;
      // Byte for byte the same definitions, flags and order before and after the load: the
      // front of the cached prefix does not move.
      expect(JSON.stringify(second?.tools)).toBe(JSON.stringify(first?.tools));
      expect(JSON.stringify(third?.tools)).toBe(JSON.stringify(first?.tools));
      const tools = sentTools(first);
      expect(tools.map((item) => item.name)).toEqual(tools.map((item) => item.name).toSorted());
      expect(tools.find((item) => item.name === 'load_tools')).toEqual({
        name: 'load_tools',
        deferred: false,
      });
      const offered = CONVERSATIONS.filter((name) => tools.some((item) => item.name === name));
      expect(offered).toContain('list_sessions');
      for (const name of offered) {
        expect(tools.find((item) => item.name === name)?.deferred).toBe(true);
      }
      expect(first?.tools?.some((item) => item.cache_control)).toBe(false);
      // The load answers with a reference to each tool it brought in, which Anthropic expands.
      expect(referencedIn(second).toSorted()).toEqual([...offered].toSorted());
      // And the loaded tool runs.
      expect(resultOf(third, 'toolu_2')?.is_error).not.toBe(true);
    },
  );

  it('refuses a deferred tool the agent has not loaded', async () => {
    const modelId = 'claude-opus-5-5';
    const { services, profile, ask } = await conversation({ provider: 'anthropic', modelId });
    const run = await ask('What else are we talking about?');
    const claude = fakeClaude(modelId, (request, index) =>
      request.stream && index === 0 ? { tool: 'list_sessions' } : { text: 'I could not look.' },
    );

    await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

    const refused = resultOf(steps(claude.requests)[1], 'toolu_1');
    expect(refused?.is_error).toBe(true);
    expect(JSON.stringify(refused?.content)).toContain('unavailable tool');
    const started = (await services.lifecycle.checkpoints(profile.id, run.id)).filter(
      (checkpoint) => (checkpoint.data as { phase?: string }).phase === 'tool-started',
    );
    expect(started).toHaveLength(0);
  });

  it('a loaded tool whose reference left the history is sent loaded', async () => {
    const modelId = 'claude-opus-5-5';
    const { services, profile, ask } = await conversation({ provider: 'anthropic', modelId });
    if (!services.web) throw new Error('Web tools unavailable');
    services.web.tools = () => ({
      large_result: tool({
        description: 'Return a large synthetic result.',
        inputSchema: z.object({}),
        execute: async () => 'x'.repeat(10_000),
      }),
    });
    const run = await ask('What else are we talking about?');
    const plan: ClaudeReply[] = [
      { tool: 'load_tools', input: { groups: ['conversations', 'tasks'] } },
      { tool: 'large_result' },
      { tool: 'compact_context' },
      { tool: 'list_sessions' },
      { text: 'Only this one.' },
    ];
    let step = 0;
    const claude = fakeClaude(modelId, (request) =>
      request.stream
        ? (plan[step++] ?? { text: 'Done.' })
        : { text: 'Checkpoint: the conversations group was loaded and a large result read.' },
    );

    await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

    expect((await services.runs.run(profile.id, run.id)).output).toBe('Only this one.');
    const sent = steps(claude.requests);
    expect(sent).toHaveLength(5);
    const listed = (request: ClaudeRequest | undefined) =>
      sentTools(request).find((item) => item.name === 'list_sessions');
    // Referenced, it is deferred; once the summary took the load's result away, it is sent
    // whole, so it stays callable.
    expect(listed(sent[1])).toEqual({ name: 'list_sessions', deferred: true });
    expect(referencedIn(sent[3])).toEqual([]);
    expect(JSON.stringify(sent[3]?.messages)).toContain('Checkpoint: the conversations group');
    expect(listed(sent[3])).toEqual({ name: 'list_sessions', deferred: false });
    expect(resultOf(sent[4], 'toolu_4')?.is_error).not.toBe(true);
  });

  it('sends a tool loaded in an earlier turn loaded', async () => {
    const modelId = 'claude-opus-5-5';
    const { services, profile, ask } = await conversation({ provider: 'anthropic', modelId });
    const first = await ask('Load what you need to see my conversations.');
    const claude = fakeClaude(modelId, (request, index) =>
      request.stream && index === 0
        ? { tool: 'load_tools', input: { groups: ['conversations'] } }
        : { text: 'Loaded.' },
    );
    await new AgentRuntime(services, () => claude.model).execute(profile.id, first.id);
    const second = await ask('Now list them.');
    const before = claude.requests.length;

    await new AgentRuntime(services, () => claude.model).execute(profile.id, second.id);

    const opening = steps(claude.requests.slice(before))[0];
    // The next turn's history holds no reference: what the conversation keeps loaded is sent
    // whole, as it is on every turn after.
    expect(referencedIn(opening)).toEqual([]);
    expect(sentTools(opening).find((item) => item.name === 'list_sessions')).toEqual({
      name: 'list_sessions',
      deferred: false,
    });
  });
});

describe('tool loading elsewhere', () => {
  it.each([
    { provider: 'openai', modelId: 'gpt-4o-mini' },
    { provider: 'anthropic', modelId: 'claude-opus-4-1-20250805' },
    { provider: 'anthropic', modelId: 'test' },
  ])('other providers still get only the active tools ($provider $modelId)', async (model) => {
    const { services, profile, ask } = await conversation(model);
    const run = await ask('What else are we talking about?');
    const offered: string[][] = [];
    const prompts: string[] = [];
    let step = 0;
    const mock = mockModel({
      doGenerate: async (options) => {
        if (!options.tools?.length) return answer('Summary.');
        offered.push(options.tools.map((item) => item.name));
        prompts.push(JSON.stringify(options.prompt));
        expect(
          options.tools.some(
            (item) => item.type === 'function' && item.providerOptions?.anthropic?.deferLoading,
          ),
        ).toBe(false);
        return step++ === 0
          ? call('load_tools', { groups: ['conversations'] })
          : answer('Only this one.');
      },
    });

    await new AgentRuntime(services, () => mock).execute(profile.id, run.id);

    expect(offered).toHaveLength(2);
    expect(offered[0]).not.toContain('list_sessions');
    expect(offered[1]).toContain('list_sessions');
    expect(prompts[1]).not.toContain('tool-reference');
  });
});

describe('the context estimate on Claude', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  /** An MCP server offering `count` tools, each described in `size` characters. */
  async function catalogServer(count: number, size: number) {
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body || '{}');
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'archive', version: '1' },
            }
          : message.method === 'tools/list'
            ? {
                tools: Array.from({ length: count }, (_, index) => ({
                  name: `record_${index}`,
                  description: `Archived record ${index}. ${'d'.repeat(size)}`,
                  inputSchema: { type: 'object', properties: {} },
                })),
              }
            : { content: [{ type: 'text', text: 'ok' }] };
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
    close = async () => {
      await outbound.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    return { url: `${origin}/mcp`, outbound };
  }

  it('deferred tools do not count toward the context estimate', async () => {
    const count = 200;
    const size = 2_000;
    const { url, outbound } = await catalogServer(count, size);
    const { services, profile, ask } = await conversation(
      { provider: 'anthropic', modelId: 'claude-opus-5-5' },
      { inputTokens: 400_000, outputTokens: 4096 },
    );
    await services.mcp.replace({ servers: [{ name: 'archive', url }] });
    const run = await ask('Find record 7.');
    let sentCount = 0;
    let step = 0;
    const mock = mockModel({
      doGenerate: async (options) => {
        if (!options.tools?.length) return answer('Summary.');
        sentCount = Math.max(sentCount, options.tools.length);
        if (step++ > 0) return answer('Found it.');
        const record = options.tools.find((item) => item.name.includes('record_7_'))?.name;
        return call('load_mcp_tools', { names: [record] });
      },
    });

    await new AgentRuntime(services, () => mock, { outbound }).execute(profile.id, run.id);

    expect((await services.runs.run(profile.id, run.id)).output).toBe('Found it.');
    // Every tool of the catalog went with each request, deferred.
    expect(sentCount).toBeGreaterThan(count);
    const prompts = (await services.lifecycle.checkpoints(profile.id, run.id))
      .map((checkpoint) => checkpoint.data as { phase?: string; prompt?: { tools: number } })
      .filter((data) => data.phase === 'step-completed')
      .map((data) => data.prompt?.tools ?? 0)
      // Listed newest first.
      .reverse();
    expect(prompts).toHaveLength(2);
    const [before = 0, after = 0] = prompts;
    // Unreferenced, the catalog costs nothing; the one tool loaded is counted, once.
    expect(before).toBeLessThan((count * size) / 10);
    expect(after - before).toBeGreaterThan(size);
    expect(after - before).toBeLessThan(size * 2);
  });

  it('lets go of loaded tools under window pressure, references and all', async () => {
    // Two loaded tools whose definitions alone overflow the window beside the instructions.
    const { url, outbound } = await catalogServer(3, 30_000);
    const { services, profile, ask } = await conversation(
      { provider: 'anthropic', modelId: 'claude-opus-5-5' },
      { inputTokens: 40_000, outputTokens: 4096 },
    );
    await services.mcp.replace({ servers: [{ name: 'archive', url }] });
    const run = await ask('Find records 0 and 1.');
    const seen: Array<{ prompt: string; deferred: string[] }> = [];
    const records: string[] = [];
    let step = 0;
    const mock = mockModel({
      doGenerate: async (options) => {
        if (!options.tools?.length) return answer('Summary.');
        seen.push({
          prompt: JSON.stringify(options.prompt),
          deferred: options.tools.flatMap((item) =>
            item.type === 'function' && item.providerOptions?.anthropic?.deferLoading
              ? [item.name]
              : [],
          ),
        });
        if (!records.length) {
          records.push(
            ...options.tools.map((item) => item.name).filter((name) => /record_[01]_/.test(name)),
          );
        }
        switch (step++) {
          case 0:
            return call('load_mcp_tools', { names: records });
          case 1:
            return call(records[0] ?? '', {});
          default:
            return answer('They were let go of.');
        }
      },
    });

    await new AgentRuntime(services, () => mock, { outbound }).execute(profile.id, run.id);

    expect((await services.runs.run(profile.id, run.id)).output).toBe('They were let go of.');
    expect(records).toHaveLength(2);
    const truncated = (await services.lifecycle.checkpoints(profile.id, run.id))
      .map((checkpoint) => checkpoint.data as { phase?: string; droppedTools?: string[] })
      .find((data) => data.phase === 'context-truncated');
    expect(truncated?.droppedTools).toEqual(expect.arrayContaining(records));
    // The step after the load no longer references them, sends them deferred, and refuses them.
    expect(seen[1]?.prompt).not.toContain('tool-reference');
    expect(seen[1]?.deferred).toEqual(expect.arrayContaining(records));
    expect(seen[2]?.prompt).toContain('unavailable tool');
  });
});

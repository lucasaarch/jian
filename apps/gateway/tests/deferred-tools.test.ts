import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ModelMessage, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { refusedForm } from '../src/agent/deferred-fallback.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { TOOL_GROUPS } from '../src/agent/tools.js';
import { truncatePrompt } from '../src/context/budget.js';
import { createSafeFetch } from '../src/security/outbound.js';
import {
  addedIn,
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
      // Only references: Anthropic refuses a tool_result that mixes them with text ("Tool
      // definitions/code execution functions cannot be mixed with other content").
      const load = resultOf(second, 'toolu_1')?.content as Array<{ type: string }> | undefined;
      expect(load?.map((block) => block.type)).toEqual(offered.map(() => 'tool_reference'));
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

  it('keeps what a tool said when its call brings other tools in', async () => {
    const modelId = 'claude-opus-5-5';
    const { services, profile, ask } = await conversation({ provider: 'anthropic', modelId });
    if (!services.web) throw new Error('Web tools unavailable');
    // Past the result budget: it is stored, and its call brings read_artifact in.
    services.web.tools = () => ({
      large_result: tool({
        description: 'Return a large synthetic result.',
        inputSchema: z.object({}),
        execute: async () => `Report begins. ${'x'.repeat(200_000)}`,
      }),
    });
    const run = await ask('Read the report.');
    const plan: ClaudeReply[] = [{ tool: 'large_result' }, { text: 'Read.' }];
    let step = 0;
    const claude = fakeClaude(modelId, (request) =>
      request.stream ? (plan[step++] ?? { text: 'Done.' }) : { text: 'Done.' },
    );

    await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

    const sent = steps(claude.requests);
    const result = JSON.stringify(resultOf(sent[1], 'toolu_1')?.content);
    // Only a load answers with references alone; any other result keeps its own words.
    expect(result).toContain('Report begins.');
    expect(result).toContain('truncated');
    expect(result).not.toContain('tool_reference');
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

  /** A conversation on `modelId` whose first turn loaded the conversations group. */
  async function afterALoad(modelId: string) {
    const { services, profile, ask } = await conversation({ provider: 'anthropic', modelId });
    let plan: ClaudeReply[] = [
      { tool: 'load_tools', input: { groups: ['conversations'] } },
      { text: 'Loaded.' },
    ];
    let step = 0;
    const claude = fakeClaude(modelId, (request) =>
      request.stream ? (plan[step++] ?? { text: 'Done.' }) : { text: 'Done.' },
    );
    const first = await ask('Load what you need to see my conversations.');
    await new AgentRuntime(services, () => claude.model).execute(profile.id, first.id);
    /** Runs a turn answered by `replies`; returns it, the requests it sent and the first index. */
    const turn = async (text: string, replies: ClaudeReply[]) => {
      plan = replies;
      step = 0;
      const before = claude.requests.length;
      const run = await ask(text);
      await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);
      return {
        run: await services.runs.run(profile.id, run.id),
        sent: steps(claude.requests.slice(before)),
        before,
      };
    };
    return { services, claude, lastOfFirst: steps(claude.requests).at(-1), turn };
  }

  const offeredIn = (request: ClaudeRequest | undefined) =>
    CONVERSATIONS.filter((name) => sentTools(request).some((item) => item.name === name));

  it('keeps the tools sent to Claude the same from one turn to the next', async () => {
    const { lastOfFirst, turn } = await afterALoad('claude-opus-5-5');

    const { run, sent, before } = await turn('Now list them.', [
      { tool: 'list_sessions' },
      { text: 'Only this one.' },
    ]);

    expect(run.output).toBe('Only this one.');
    const [opening, next] = sent;
    // The tools are byte for byte what the last turn ended on, so the turn reads its start back.
    expect(JSON.stringify(opening?.tools)).toBe(JSON.stringify(lastOfFirst?.tools));
    expect(sentTools(opening).find((item) => item.name === 'list_sessions')).toEqual({
      name: 'list_sessions',
      deferred: true,
    });
    // What the conversation kept loaded is added back by a system message ending the request,
    // after the history the cache marks.
    const offered = offeredIn(opening);
    expect(addedIn(opening).toSorted()).toEqual([...offered].toSorted());
    expect(opening?.messages.at(-1)?.role).toBe('system');
    expect(opening?.beta).toContain('mid-conversation-tool-changes-2026-07-01');
    const marked = (opening?.messages ?? []).findIndex(
      (message) =>
        typeof message.content !== 'string' && message.content.some((block) => block.cache_control),
    );
    expect(marked).toBeGreaterThanOrEqual(0);
    expect(marked).toBeLessThan((opening?.messages.length ?? 0) - 1);
    // Kept where it was, it now sits right before the first reply.
    const at = next?.messages.findIndex((message) => message.role === 'system') ?? -1;
    expect(next?.messages[at + 1]?.role).toBe('assistant');
    expect(addedIn(next)).toEqual(addedIn(opening));
    // And the carried tool runs.
    expect(resultOf(next, `toolu_${before + 1}`)?.is_error).not.toBe(true);
  });

  it('sends what an earlier turn loaded whole on a Claude without tool changes', async () => {
    const { turn } = await afterALoad('claude-sonnet-4-5');

    const { sent } = await turn('Now list them.', [{ text: 'Only this one.' }]);

    const [opening] = sent;
    expect(addedIn(opening)).toEqual([]);
    expect(opening?.messages.some((message) => message.role === 'system')).toBe(false);
    expect(sentTools(opening).find((item) => item.name === 'list_sessions')).toEqual({
      name: 'list_sessions',
      deferred: false,
    });
  });

  it('drops only the carry when Claude refuses tool additions', async () => {
    // A model of its own: a refusal is remembered for the model for the rest of the process.
    const modelId = 'claude-opus-4-8';
    const { turn } = await afterALoad(modelId);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const { run, sent } = await turn('Now list them.', [
        { refuse: 'messages.6.content.0: tool_addition is not supported for this model' },
        { tool: 'list_sessions' },
        { text: 'Only this one.' },
      ]);

      expect(run.output).toBe('Only this one.');
      const [refused, retried, after] = sent;
      expect(addedIn(refused).length).toBeGreaterThan(0);
      // Sent again with the carried tools whole, and everything else still deferred.
      for (const request of [retried, after]) {
        expect(request?.messages.some((message) => message.role === 'system')).toBe(false);
        expect(sentTools(request).find((item) => item.name === 'list_sessions')).toEqual({
          name: 'list_sessions',
          deferred: false,
        });
        expect(sentTools(request).some((item) => item.deferred)).toBe(true);
      }
      const said = errors.filter((line) => line.includes('refused carried tool additions'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(modelId);

      // A later turn on that model starts without the carry, still deferring.
      const later = await turn('Again.', [{ text: 'Still one.' }]);
      expect(addedIn(later.sent[0])).toEqual([]);
      expect(sentTools(later.sent[0]).some((item) => item.deferred)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('remembers nothing when the retry is refused too', async () => {
    const modelId = 'claude-fable-5-1';
    const { turn } = await afterALoad(modelId);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const { run, sent } = await turn('Now list them.', [
        { refuse: 'messages.6.content.0: tool_addition is not supported for this model' },
        { refuse: 'messages: something else entirely' },
      ]);

      expect(run.status).toBe('failed');
      expect(run.error).toContain('tool_addition');
      expect(sent).toHaveLength(2);
      expect(errors.some((line) => line.includes('refused carried tool additions'))).toBe(false);

      // Nothing was believed: the next turn carries again.
      const later = await turn('Again.', [{ text: 'Still one.' }]);
      expect(addedIn(later.sent[0]).length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('tries the old way on any refusal of a deferred request, and keeps it only if it works', async () => {
    // A model of its own: a refusal is remembered for the model for the rest of the process.
    const modelId = 'claude-opus-4-6';
    const { services, profile, ask } = await conversation({ provider: 'anthropic', modelId });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const run = await ask('What else are we talking about?');
      // Worded so no pattern knows it: Anthropic has refused this form in words of its own.
      const plan: ClaudeReply[] = [
        { refuse: 'Something about this request is not supported' },
        { tool: 'load_tools', input: { groups: ['conversations'] } },
        { tool: 'list_sessions' },
        { text: 'Only this one.' },
      ];
      let step = 0;
      const claude = fakeClaude(modelId, (request) =>
        request.stream ? (plan[step++] ?? { text: 'Done.' }) : { text: 'Done.' },
      );

      await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

      expect((await services.runs.run(profile.id, run.id)).output).toBe('Only this one.');
      const sent = steps(claude.requests);
      expect(sentTools(sent[0]).some((item) => item.deferred)).toBe(true);
      for (const request of sent.slice(1)) {
        expect(sentTools(request).some((item) => item.deferred)).toBe(false);
      }
      expect(errors.filter((line) => line.includes('refused deferred tools'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('loads the old way when Claude refuses the deferred form', async () => {
    // A model of its own: a refusal is remembered for the model for the rest of the process.
    const modelId = 'claude-haiku-4-5';
    const { services, profile, ask } = await conversation({ provider: 'anthropic', modelId });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const run = await ask('What else are we talking about?');
      const plan: ClaudeReply[] = [
        { refuse: 'tools.12.defer_loading: Extra inputs are not permitted' },
        { tool: 'load_tools', input: { groups: ['conversations'] } },
        { tool: 'list_sessions' },
        { text: 'Only this one.' },
      ];
      let step = 0;
      const claude = fakeClaude(modelId, (request) =>
        request.stream ? (plan[step++] ?? { text: 'Done.' }) : { text: 'Done.' },
      );

      await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

      expect((await services.runs.run(profile.id, run.id)).output).toBe('Only this one.');
      const sent = steps(claude.requests);
      expect(sent).toHaveLength(4);
      expect(sentTools(sent[0]).some((item) => item.deferred)).toBe(true);
      // The refused step went again narrowed, and so did the rest of the run.
      for (const request of sent.slice(1)) {
        expect(sentTools(request).some((item) => item.deferred)).toBe(false);
        expect(referencedIn(request)).toEqual([]);
      }
      expect(sentTools(sent[1]).some((item) => item.name === 'list_sessions')).toBe(false);
      expect(sentTools(sent[2]).some((item) => item.name === 'list_sessions')).toBe(true);
      expect(resultOf(sent[3], 'toolu_3')?.is_error).not.toBe(true);
      const said = errors.filter((line) => line.includes('refused deferred tools'));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain(modelId);
      expect(said[0]).not.toContain('What else are we talking about?');

      // A later run on that model goes narrowed from its start.
      const later = await ask('And now?');
      const before = claude.requests.length;
      step = 3;
      await new AgentRuntime(services, () => claude.model).execute(profile.id, later.id);
      const opening = steps(claude.requests.slice(before))[0];
      expect(opening).toBeDefined();
      expect(sentTools(opening).some((item) => item.deferred)).toBe(false);
      // What the conversation kept loaded is sent whole, with no made-up load to reference it.
      expect(sentTools(opening).find((item) => item.name === 'list_sessions')).toEqual({
        name: 'list_sessions',
        deferred: false,
      });
      expect(referencedIn(opening)).toEqual([]);
      expect(opening?.messages.some((message) => message.role === 'system')).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not take another refusal for the deferred form', async () => {
    const modelId = 'claude-sonnet-5';
    const { services, profile, ask } = await conversation({ provider: 'anthropic', modelId });
    const run = await ask('What else are we talking about?');
    const claude = fakeClaude(modelId, (request, index) =>
      // Refused again the old way too, as a mistake of the request's own is.
      request.stream && index < 2
        ? { refuse: 'max_tokens: 900000 > 128000, which is the maximum allowed' }
        : { text: 'Answered.' },
    );

    await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

    const finished = await services.runs.run(profile.id, run.id);
    expect(finished.status).toBe('failed');
    expect(finished.error).toContain('max_tokens');
    // Tried once the old way, which failed too: the first refusal is what the run reports.
    expect(steps(claude.requests)).toHaveLength(2);
    // Nothing was remembered against the model.
    const later = await ask('Again.');
    const before = claude.requests.length;
    await new AgentRuntime(services, () => claude.model).execute(profile.id, later.id);
    expect(sentTools(steps(claude.requests.slice(before))[0]).some((item) => item.deferred)).toBe(
      true,
    );
  });
});

describe('shedding a result', () => {
  it('keeps the tool references of a result it puts aside', () => {
    const reference = {
      type: 'custom' as const,
      providerOptions: { anthropic: { type: 'tool-reference', toolName: 'list_sessions' } },
    };
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Look.' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'load', toolName: 'load_tools', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'load',
            toolName: 'load_tools',
            output: {
              type: 'content',
              value: [{ type: 'text', text: 'x'.repeat(40_000) }, reference],
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'read', toolName: 'read_file', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'read',
            toolName: 'read_file',
            output: { type: 'text', value: 'y'.repeat(10_000) },
          },
        ],
      },
    ];
    const truncated = truncatePrompt({
      provider: 'anthropic',
      modelId: 'claude-opus-5-5',
      policy: { inputTokens: 16_000, outputTokens: 1_000 },
      instructions: 'Help.',
      messages,
      tools: {},
      currentStartIndex: 0,
    });
    expect(truncated?.shedResults).toBe(1);
    const shed = truncated?.messages[2];
    expect(JSON.stringify(shed)).not.toContain('x'.repeat(100));
    expect(JSON.stringify(shed)).toContain('read_artifact');
    expect(JSON.stringify(shed)).toContain('"toolName":"list_sessions"');
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

describe('which refusal is of the deferred form', () => {
  const refusal = (message: string) => ({
    statusCode: 400,
    message,
    responseBody: JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message },
    }),
  });

  it('takes Anthropic refusing references beside other content for the deferred form', () => {
    // As Anthropic said it, on Sonnet 5.5, to a load answered with text and references.
    const said = 'Tool definitions/code execution functions cannot be mixed with other content';
    expect(refusedForm(refusal(said), false)).toBe('deferral');
  });

  it('leaves an unrelated refusal alone', () => {
    expect(refusedForm(refusal('max_tokens: must be less than 128000'), false)).toBeUndefined();
  });
});

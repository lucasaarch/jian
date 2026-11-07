import { tool } from 'ai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { boundToolResult, fitStep } from '../src/agent/results.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { profileTools } from '../src/agent/tools.js';
import { tokenCounter } from '../src/context/budget.js';
import { Coordination } from '../src/coordination/service.js';
import { checkpoints } from '../src/storage/schema.js';
import { fakeClaude, resultOf } from './helpers/claude.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

async function fixture(
  model = { provider: 'openai', modelId: 'test' },
  contextPolicy: Record<string, number> = { toolResultTokens: 2560 },
) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Reader',
    instructions: 'Help.',
    contextPolicy,
    model: { ...model, apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Results' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Read',
    requestKey: 'read',
  });
  return { services, profile, session, run };
}

const CLAUDE = { provider: 'anthropic', modelId: 'claude-opus-5-5' };
/** About 1,000 of Claude's tokens per 2,400 bytes, as a conversation measured it (0.41). */
const note = (bytes: number) => ({ content: 'Delivery note. '.repeat(Math.ceil(bytes / 15)) });
const stored = {
  storeArtifact: async () => ({ artifactId: 'stored-result', bytes: 1 }),
};

it('gives a Claude result the room its budget names, counted in Claude tokens', async () => {
  const { run } = await fixture(CLAUDE, { toolResultTokens: 12_000 });
  // About 10,000 tokens to Claude, at the scale its conversation measured: within 12,000. Read
  // a byte a token, as before, it was cut at about 5,000 and paged with read_artifact.
  const fits = note(24_000);
  expect(await boundToolResult(fits, 'read_file', run, new Set(), stored, 0.41)).toEqual(fits);
  // Before anything was measured, the default scale for Claude (a half) still lets 20 KB in.
  const unmeasured = note(20_000);
  expect(await boundToolResult(unmeasured, 'read_file', run, new Set(), stored)).toEqual(
    unmeasured,
  );
  // Well past the budget, it is stored and previewed within it, in the same tokens.
  const far = await boundToolResult(note(60_000), 'read_file', run, new Set(), stored, 0.41);
  expect(far).toMatchObject({ truncated: true, artifactId: 'stored-result' });
  const tokens = Math.ceil(tokenCounter('anthropic', CLAUDE.modelId)(JSON.stringify(far)) * 0.41);
  expect(tokens).toBeLessThanOrEqual(12_000);
  // And the text kept fills that room, rather than the 12,000 bytes it used to.
  expect((far as { content: string }).content.length).toBeGreaterThan(12_000);
});

it('counts an OpenAI-style result as before', async () => {
  const { run } = await fixture(undefined, { toolResultTokens: 12_000 });
  // Counted a token a byte with a scale of one: 24 KB is past 12,000.
  expect(await boundToolResult(note(24_000), 'read_file', run, new Set(), stored)).toMatchObject({
    truncated: true,
  });
  expect(await boundToolResult(note(11_000), 'read_file', run, new Set(), stored)).toEqual(
    note(11_000),
  );
});

it('hands Claude a 20 KB result whole in the next step of the turn', async () => {
  const { services, profile, session } = await fixture(CLAUDE, { toolResultTokens: 12_000 });
  if (!services.web) throw new Error('Web tools unavailable');
  const text = 'Line of the delivery report.\n'.repeat(700);
  services.web.tools = () => ({
    delivery_report: tool({
      description: 'Return the synthetic delivery report.',
      inputSchema: z.object({}),
      execute: async () => text,
    }),
  });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Read the delivery report.',
    requestKey: 'report',
  });
  let step = 0;
  const claude = fakeClaude(CLAUDE.modelId, (request) =>
    request.stream
      ? step++ === 0
        ? { tool: 'delivery_report' }
        : { text: 'Read it.' }
      : { text: 'Report' },
  );

  await new AgentRuntime(services, () => claude.model).execute(profile.id, run.id);

  const second = claude.requests.filter((request) => request.stream)[1];
  expect(JSON.stringify(resultOf(second, 'toolu_1')?.content)).toContain(
    JSON.stringify(text).slice(1, 200),
  );
  expect(JSON.stringify(resultOf(second, 'toolu_1')?.content)).not.toContain('truncated');
});

it('keeps structured MCP data readable without encoding JSON inside JSON', async () => {
  const { run } = await fixture();
  const data = { items: [{ id: 'receipt-123', title: 'Delivery', state: 'OPEN' }] };
  const result = await boundToolResult(
    {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      isError: true,
    },
    'mcp__test_search',
    run,
    new Set(),
    {},
  );
  expect(result).toEqual({ data, isError: true });
});

it('reads full pages within the token limit without skipping Unicode or JSON escapes', async () => {
  const { services, run } = await fixture();
  const coordination = new Coordination(services);
  const original = { value: 'Delivery to São Paulo "ready"\n'.repeat(160) };
  const artifact = await coordination.storeArtifact(run, 'read', original);
  const read = profileTools(services, run).read_artifact?.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<{ content: string; nextOffset: number | null }>;
  let offset: number | null = 0;
  let content = '';
  const count = tokenCounter(run.profile.model.provider, run.profile.model.modelId);
  let pages = 0;
  while (offset !== null) {
    const page = await read(
      { artifactId: artifact.artifactId, offset, limit: 4000 },
      { messages: [], toolCallId: 'read' },
    );
    expect(count(JSON.stringify(page))).toBeLessThanOrEqual(2560);
    if (pages === 0) expect(page.content.length).toBeGreaterThan(1200);
    content += page.content;
    offset = page.nextOffset;
    expect(++pages).toBeLessThan(10);
  }
  expect(JSON.parse(content)).toEqual(original);
});

it('keeps full local output in an artifact and shows both ends of it', async () => {
  const { run } = await fixture();
  const stdout = `START\n${'ordinary output\n'.repeat(1200)}END`;
  const saved: unknown[] = [];
  const output = { exitCode: 0, stdout, stderr: '' };
  const result = await boundToolResult(output, 'run_command', run, new Set(), {
    storeArtifact: async (_run, _name, value) => {
      saved.push(value);
      return { artifactId: 'saved-output', bytes: Buffer.byteLength(JSON.stringify(value)) };
    },
  });
  expect(saved).toEqual([output]);
  expect(result).toMatchObject({ truncated: true, artifactId: 'saved-output', exitCode: 0 });
  const kept = (result as { stdout: string }).stdout;
  expect(kept).toContain('START');
  expect(kept).toContain('END');
  expect(kept).toContain('read_artifact with artifactId "saved-output"');
  expect(tokenCounter('openai', 'test')(JSON.stringify(result))).toBeLessThanOrEqual(2560);
});

it('keeps the end of a long command output, where its error is, with what was left out', async () => {
  const { run } = await fixture();
  const stdout = `START\n${'compiling module\n'.repeat(3000)}error: build failed at step 9\n`;
  const result = await boundToolResult(
    { exitCode: 1, stdout, stderr: '' },
    'run_command',
    run,
    new Set(),
    stored,
  );
  expect(result).toMatchObject({ truncated: true, artifactId: 'stored-result', exitCode: 1 });
  const kept = (result as { stdout: string }).stdout;
  expect(kept.startsWith('[3,002 lines, about ')).toBe(true);
  expect(kept).toMatch(/about [\d,]+ tokens/);
  expect(kept).toContain('START');
  expect(kept).toContain('error: build failed at step 9');
  expect(kept).toMatch(/\[… [\d,]+ lines \([\d,]+ characters\) left out here/);
  expect(kept).toContain('read_artifact with artifactId "stored-result" returns everything');
  expect(tokenCounter('openai', 'test')(JSON.stringify(result))).toBeLessThanOrEqual(2560);
});

it('prioritizes shell failure details and leaves MCP errors unchanged', async () => {
  const { run } = await fixture();
  const failure = {
    exitCode: 2,
    stdout: 'ordinary output\n'.repeat(1200),
    stderr: 'VALIDATION FAILED: missing field',
  };
  const options = {
    storeArtifact: async () => ({ artifactId: 'failure-output', bytes: 30000 }),
  };
  const result = await boundToolResult(failure, 'run_command', run, new Set(), options);
  expect(result).toMatchObject({ exitCode: 2, stderr: 'VALIDATION FAILED: missing field' });

  const mcp = { content: [{ type: 'text', text: 'Remote operation refused' }], isError: true };
  expect(await boundToolResult(mcp, 'mcp__remote_write', run, new Set(), options)).toEqual(mcp);
});

it('keeps the file, its length and both ends of a long read', async () => {
  const { run } = await fixture();
  const output = {
    path: '/workspace/report.txt',
    totalLines: 1202,
    content: `1\tFIRST\n${'middle\n'.repeat(1200)}1202\tLAST`,
  };
  const result = await boundToolResult(output, 'read_file', run, new Set(), {
    storeArtifact: async () => ({ artifactId: 'file-output', bytes: 10000 }),
  });
  expect(result).toMatchObject({
    truncated: true,
    artifactId: 'file-output',
    path: '/workspace/report.txt',
    totalLines: 1202,
  });
  const content = (result as { content: string }).content;
  expect(content.startsWith('[1,202 lines, about ')).toBe(true);
  expect(content).toContain('FIRST');
  expect(content).toContain('1202\tLAST');
  expect(content).toContain('read_artifact with artifactId "file-output"');
});

it('keeps a structured result structured, with a preview and the artifact', async () => {
  const { run } = await fixture();
  const output = {
    items: Array.from({ length: 400 }, (_, index) => ({ id: `invoice-${index}`, total: index })),
  };
  const result = await boundToolResult(output, 'list_invoices', run, new Set(), stored);
  expect(result).toMatchObject({ truncated: true, artifactId: 'stored-result' });
  expect((result as { preview: string }).preview.startsWith('{"items":[{"id":"invoice-0"')).toBe(
    true,
  );
});

it('preserves and reads a large MCP diff through its final byte beyond the former one-megabyte limit', async () => {
  const { services, run: originalRun } = await fixture();
  const run = {
    ...originalRun,
    contextPolicy: { ...originalRun.profile.contextPolicy, toolResultTokens: 32000 },
  };
  const coordination = new Coordination(services);
  const output = {
    content: [
      {
        type: 'text',
        text: `diff --git a/sample.ts b/sample.ts\n${'+ full diff line\n'.repeat(80000)}+ FINAL CHANGE São Paulo 😀`,
      },
    ],
  };
  type Page = { content: string; nextOffset: number | null; artifactId: string };
  // Plain text: its first and last lines, the final change among them, and where the rest is.
  const cut = (await boundToolResult(output, 'mcp__synthetic_diff', run, new Set(), {
    storeArtifact: (run, name, output) => coordination.storeArtifact(run, name, output),
  })) as { truncated: true; artifactId: string; content: Array<{ type: string; text: string }> };
  expect(cut).toMatchObject({ truncated: true, content: [{ type: 'text' }] });
  expect(cut.content[0]?.text).toContain('diff --git a/sample.ts b/sample.ts');
  expect(cut.content[0]?.text).toContain('+ FINAL CHANGE São Paulo 😀');
  const artifactId = cut.artifactId;
  const reader = profileTools(services, run).read_artifact?.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<Page>;
  let page: Page = { content: '', nextOffset: 0, artifactId };
  let complete = '';
  while (page.nextOffset !== null) {
    const offset = page.nextOffset;
    page = await reader({ artifactId, offset, limit: 16000 }, { toolCallId: 'page', messages: [] });
    expect(page.nextOffset === null || page.nextOffset > offset).toBe(true);
    expect(tokenCounter('openai', 'test')(JSON.stringify(page))).toBeLessThanOrEqual(32000);
    complete += page.content;
  }
  expect(JSON.parse(complete)).toEqual(output);
  const end = await coordination.artifact(run.profileId, artifactId, {
    offset: 1100000,
    limit: 16000,
  });
  expect(end.content).toBe(complete.slice(1100000, 1116000));
});

it('reports an unavailable full result explicitly without retrying an external mutation', async () => {
  const { run } = await fixture();
  const result = await boundToolResult(
    { content: [{ type: 'text', text: 'large result'.repeat(2000) }] },
    'mcp__synthetic_write',
    run,
    new Set(),
    {
      storeArtifact: async () => {
        throw new Error('Synthetic storage failure');
      },
    },
  );
  expect(result).toMatchObject({ incomplete: true });
  expect(result).not.toHaveProperty('artifactId', expect.any(String));
  expect(JSON.stringify(result)).toContain('Do not treat it as the full result');
});

it('cuts the largest results of one step first, until the step fits three results’ room', async () => {
  const { run } = await fixture();
  const count = tokenCounter('openai', 'test');
  const ids: string[] = [];
  const options = {
    storeArtifact: async (_run: unknown, name: string) => {
      ids.push(name);
      return { artifactId: `stored-${ids.length}`, bytes: 1 };
    },
  };
  const text = (lines: number, tag: string) =>
    `${tag} FIRST\n${`${tag} line of the build log\n`.repeat(lines)}${tag} LAST ERROR`;
  const outputs = [
    { id: 'huge-a', output: { exitCode: 1, stdout: text(4000, 'a'), stderr: '' } },
    { id: 'huge-b', output: { exitCode: 1, stdout: text(3000, 'b'), stderr: '' } },
    { id: 'huge-c', output: { exitCode: 1, stdout: text(2000, 'c'), stderr: '' } },
    { id: 'medium', output: { exitCode: 0, stdout: text(55, 'm'), stderr: '' } },
    { id: 'small', output: { exitCode: 0, stdout: 'ok', stderr: '' } },
  ];
  const step = await Promise.all(
    outputs.map(async ({ id, output }) => ({
      toolCallId: id,
      toolName: 'run_command',
      output,
      result: await boundToolResult(output, 'run_command', run, new Set(), options),
    })),
  );
  const before = step.reduce((sum, entry) => sum + count(JSON.stringify(entry.result)), 0);
  expect(before).toBeGreaterThan(3 * 2560);

  const fitted = await fitStep(step, run, new Set(), options);
  const after = (entry: (typeof step)[number]) => fitted.get(entry.toolCallId) ?? entry.result;
  const total = step.reduce((sum, entry) => sum + count(JSON.stringify(after(entry))), 0);
  expect(total).toBeLessThanOrEqual(3 * 2560);

  // The small and the medium ones are left as they were; the three large ones are cut, each
  // keeping its end and the artifact it was stored in, and none was stored twice.
  expect(fitted.has('small')).toBe(false);
  expect(fitted.has('medium')).toBe(false);
  for (const [index, id] of ['huge-a', 'huge-b', 'huge-c'].entries()) {
    const entry = step.find((item) => item.toolCallId === id);
    const cut = fitted.get(id) as { artifactId: string; stdout: string; truncated: true };
    expect(cut.artifactId).toBe((entry?.result as { artifactId?: string } | undefined)?.artifactId);
    expect(cut.stdout).toContain(`${'abc'[index]} LAST ERROR`);
    expect(count(JSON.stringify(cut))).toBeLessThan(count(JSON.stringify(entry?.result)));
  }
  expect(ids).toHaveLength(3);
});

it('fits one step’s parallel results in the conversation and records them as the model saw them', async () => {
  // Room for the instructions and the four results: no summary between the calls.
  const { services, profile, session } = await fixture(undefined, {
    toolResultTokens: 2560,
    inputTokens: 64000,
  });
  if (!services.web) throw new Error('Web tools unavailable');
  services.web.tools = () => ({
    build_log: tool({
      description: 'Return a synthetic build log of the given number of lines.',
      inputSchema: z.object({ lines: z.number(), tag: z.string() }),
      execute: async ({ lines, tag }) => ({
        exitCode: 1,
        stdout: `${tag} FIRST\n${`${tag} line of the build log\n`.repeat(lines)}${tag} LAST ERROR`,
        stderr: '',
      }),
    }),
  });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Read the four logs.',
    requestKey: 'logs',
  });
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };
  const prompts: Array<Parameters<Parameters<typeof mockModel>[0]['doGenerate']>[0]['prompt']> = [];
  const model = mockModel({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      return prompts.length === 1
        ? {
            content: ['a', 'b', 'c', 'd'].map((tag, index) => ({
              type: 'tool-call' as const,
              toolCallId: `log-${tag}`,
              toolName: 'build_log',
              input: JSON.stringify({ lines: 4000 - index * 500, tag }),
            })),
            finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
            usage,
            warnings: [],
          }
        : {
            content: [{ type: 'text' as const, text: 'Read them.' }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
            warnings: [],
          };
    },
  });
  const coordination = new Coordination(services);
  await new AgentRuntime(services, () => model, {
    storeArtifact: (run, name, output) => coordination.storeArtifact(run, name, output),
  }).execute(profile.id, run.id);

  const count = tokenCounter('openai', 'test');
  const results = (prompts[1] ?? []).flatMap((message) =>
    message.role === 'tool'
      ? message.content.flatMap((part) =>
          part.type === 'tool-result' && part.output.type === 'json'
            ? [{ id: part.toolCallId, value: part.output.value }]
            : [],
        )
      : [],
  );
  expect(results).toHaveLength(4);
  expect(results.reduce((sum, item) => sum + count(JSON.stringify(item.value)), 0)).toBeLessThan(
    3 * 2560,
  );
  for (const item of results) {
    const value = item.value as { artifactId: string; stdout: string };
    expect(value.artifactId).toMatch(/^[0-9a-f-]{36}$/);
    expect(value.stdout).toContain(`${item.id.slice(-1)} LAST ERROR`);
  }
  // What the conversation keeps of the step is what the model was given.
  const rows = await services.store.db.select().from(checkpoints);
  const step = rows
    .map(
      (row) =>
        row.data as { phase?: string; tools?: Array<{ toolCallId: string; result: unknown }> },
    )
    .find((data) => data.phase === 'step-completed' && data.tools?.length);
  for (const item of results) {
    expect(step?.tools?.find((entry) => entry.toolCallId === item.id)?.result).toEqual(item.value);
  }
});

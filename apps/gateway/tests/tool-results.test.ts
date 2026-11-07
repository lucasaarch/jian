import { tool } from 'ai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { boundToolResult } from '../src/agent/results.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { profileTools } from '../src/agent/tools.js';
import { tokenCounter } from '../src/context/budget.js';
import { Coordination } from '../src/coordination/service.js';
import { fakeClaude, resultOf } from './helpers/claude.js';
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
  expect(await boundToolResult(fits, 'read_file', run, new Set(), stored, false, 0.41)).toEqual(
    fits,
  );
  // Before anything was measured, the default scale for Claude (a half) still lets 20 KB in.
  const unmeasured = note(20_000);
  expect(await boundToolResult(unmeasured, 'read_file', run, new Set(), stored)).toEqual(
    unmeasured,
  );
  // Well past the budget, it is stored and previewed within it, in the same tokens.
  const far = await boundToolResult(note(60_000), 'read_file', run, new Set(), stored, false, 0.41);
  expect(far).toMatchObject({ truncated: true, artifactId: 'stored-result' });
  const tokens = Math.ceil(tokenCounter('anthropic', CLAUDE.modelId)(JSON.stringify(far)) * 0.41);
  expect(tokens).toBeLessThanOrEqual(12_000);
  // And the preview fills that room, rather than the 12,000 bytes it used to.
  expect((far as { preview: string }).preview.length).toBeGreaterThan(12_000);
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

it('keeps full local output in an artifact and shows both ends in Caveman mode', async () => {
  const { run } = await fixture();
  const stdout = `START\n${'ordinary output\n'.repeat(1200)}END`;
  const saved: unknown[] = [];
  const output = { exitCode: 0, stdout, stderr: '' };
  const result = await boundToolResult(
    output,
    'run_command',
    run,
    new Set(),
    {
      storeArtifact: async (_run, _name, value) => {
        saved.push(value);
        return { artifactId: 'saved-output', bytes: Buffer.byteLength(JSON.stringify(value)) };
      },
    },
    true,
  );
  expect(saved).toEqual([output]);
  expect(result).toMatchObject({ truncated: true, artifactId: 'saved-output' });
  const preview = (result as { preview: string }).preview;
  expect(preview).toContain('START');
  expect(preview).toContain('END');
  expect(preview).toContain('read artifact for full output');
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
  const result = await boundToolResult(failure, 'run_command', run, new Set(), options, true);
  expect((result as { preview: string }).preview).toContain('VALIDATION FAILED: missing field');
  expect((result as { preview: string }).preview).toContain('"exitCode":2');

  const mcp = { content: [{ type: 'text', text: 'Remote operation refused' }], isError: true };
  expect(await boundToolResult(mcp, 'mcp__remote_write', run, new Set(), options, true)).toEqual(
    mcp,
  );
});

it('keeps file location and both ends of a long read in its preview', async () => {
  const { run } = await fixture();
  const output = {
    path: '/workspace/report.txt',
    totalLines: 1202,
    content: `1\tFIRST\n${'middle\n'.repeat(1200)}1202\tLAST`,
  };
  const result = await boundToolResult(
    output,
    'read_file',
    run,
    new Set(),
    { storeArtifact: async () => ({ artifactId: 'file-output', bytes: 10000 }) },
    true,
  );
  const preview = (result as { preview: string }).preview;
  expect(preview).toContain('/workspace/report.txt');
  expect(preview).toContain('1202');
  expect(preview).toContain('FIRST');
  expect(preview).toContain('LAST');
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
  let page = (await boundToolResult(output, 'mcp__synthetic_diff', run, new Set(), {
    storeArtifact: (run, name, output) => coordination.storeArtifact(run, name, output),
  })) as Page;
  expect(page).not.toHaveProperty('truncated');
  expect(page.nextOffset).not.toBeNull();
  const artifactId = page.artifactId;
  const reader = profileTools(services, run).read_artifact?.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<Page>;
  let complete = page.content;
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

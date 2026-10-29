import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileDiff, MAX_DIFF_LINES } from '../src/agent/diff.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-diff-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const numbered = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => `line ${from + index}`).join('\n');

describe('the diff of a file write', () => {
  it('numbers each line on its own side, with three lines of context and the hunk header', () => {
    const before = [
      'export function withRetry(run: () => Promise<void>) {',
      '  const max = 5;',
      '  let attempt = 0;',
      '  const backoff = 100;',
      '  while (attempt < max) {',
      '    attempt += 1;',
      '  }',
      '}',
      '',
    ].join('\n');
    const after = before.replace(
      '  const backoff = 100;',
      '  const baseBackoff = 200;\n  const jitter = () => Math.random();',
    );

    const diff = fileDiff('services/payments/retry.ts', before, after);

    expect(diff).toMatchObject({
      path: 'services/payments/retry.ts',
      language: 'typescript',
      additions: 2,
      deletions: 1,
    });
    expect(diff?.created).toBeUndefined();
    const [hunk] = diff?.hunks ?? [];
    expect(hunk).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(hunk?.lines.map((line) => [line.kind, line.old, line.new])).toEqual([
      ['context', 1, 1],
      ['context', 2, 2],
      ['context', 3, 3],
      ['del', 4, undefined],
      ['add', undefined, 4],
      ['add', undefined, 5],
      ['context', 5, 6],
      ['context', 6, 7],
      ['context', 7, 8],
    ]);
  });

  it('names the hunk after the function it sits in, as git does', () => {
    const body = numbered(20, 2)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    const before = `${['function first() {', body, '}'].join('\n')}\n`;
    const after = before.replace('line 15', 'line fifteen');

    expect(fileDiff('a.ts', before, after)?.hunks[0]?.header).toBe('function first() {');
  });

  it('shows a new file as all additions, and says it was created', () => {
    const diff = fileDiff('notes.md', undefined, 'one\ntwo\n');

    expect(diff).toMatchObject({ created: true, additions: 2, deletions: 0, language: 'markdown' });
    expect(diff?.hunks[0]?.lines.every((line) => line.kind === 'add')).toBe(true);
  });

  it('is cut past what a person reads, and says so', () => {
    const diff = fileDiff('big.txt', undefined, numbered(MAX_DIFF_LINES + 50));

    expect(diff?.additions).toBe(MAX_DIFF_LINES + 50);
    expect(diff?.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(MAX_DIFF_LINES);
    expect(diff?.truncated).toBe(true);
  });

  it('diffs a Windows file by its lines, not its line endings', () => {
    const diff = fileDiff('win.txt', 'one\r\ntwo\r\n', 'one\r\nTWO\r\n');

    expect(diff).toMatchObject({ additions: 1, deletions: 1 });
    expect(diff?.hunks[0]?.lines.map((line) => line.text)).toEqual(['one', 'two', 'TWO']);
  });

  it('has nothing to show for a write that changed nothing', () => {
    expect(fileDiff('same.txt', 'a\n', 'a\n')).toBeUndefined();
  });
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const stop = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});
const call = (toolCallId: string, toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
  usage,
  warnings: [],
});

describe('a file write in a turn', () => {
  it('keeps the diff for the owner and out of what the agent reads', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const session = await services.sessions.createGatewaySession(profile.id, {});
    await services.sessions.setProtection(profile.id, session.id, { protection: 'full' });
    const directory = join(root, profile.id, 'app');
    const file = join(directory, 'retry.ts');
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, 'const backoff = 100;\nexport { backoff };\n');
    const prompts: string[] = [];

    const runtime = new AgentRuntime(services, () =>
      mockModel({
        doGenerate: async (options) => {
          const prompt = JSON.stringify(options.prompt);
          prompts.push(prompt);

          if (!prompt.includes('"load_tools"')) {
            return call('load', 'load_tools', { groups: ['files'] });
          }
          if (!prompt.includes('read-1')) {
            return call('read-1', 'read_file', { path: file, offset: 1, limit: 2000 });
          }
          if (!prompt.includes('edit-1')) {
            return call('edit-1', 'edit_file', {
              path: file,
              edits: [{ oldString: 'backoff = 100', newString: 'baseBackoff = 200' }],
            });
          }
          return stop('Changed the backoff.');
        },
      }),
    );
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Change the backoff',
      requestKey: 'diff-turn',
    });

    await runtime.execute(profile.id, run.id);

    // The agent read back the short result it always had, never the hunks.
    const last = prompts.at(-1) ?? '';
    expect(last).toContain('replacements');
    expect(last).not.toContain('hunks');
    expect(last).not.toContain('"kind":"del"');

    const timeline = await services.sessions.timeline(profile.id, session.id);
    const step = timeline
      .flatMap((entry) => entry.steps)
      .find((item) => item.toolCallId === 'edit-1');

    expect(step?.diff).toMatchObject({ path: 'app/retry.ts', additions: 1, deletions: 1 });
    expect(step?.diff?.hunks[0]?.lines.map((line) => line.kind)).toEqual(['del', 'add', 'context']);
    // Reads carry no diff.
    expect(
      timeline.flatMap((entry) => entry.steps).find((item) => item.toolCallId === 'read-1')?.diff,
    ).toBeUndefined();
  });
});

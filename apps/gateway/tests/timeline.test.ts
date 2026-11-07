import { TOOL_DISPLAY_CHARS } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { redactOutput } from '../src/agent/results.js';
import { testServices } from './helpers/services.js';

async function setup() {
  const services = await testServices();
  const input = {
    instructions: 'Help.',
    model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  };
  const profile = await services.profiles.createProfile({ ...input, name: 'Owner' });
  const other = await services.profiles.createProfile({ ...input, name: 'Other' });
  const session = await services.sessions.createGatewaySession(profile.id, {});
  const turn = async (key: string) => {
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Look into the deploy',
      requestKey: key,
    });

    await services.lifecycle.claim(run.id, profile.id, 'worker');

    return {
      run,
      write: (data: Record<string, unknown>) =>
        services.lifecycle.checkpoint(profile.id, run.id, 'worker', data),
      finish: () => services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', 'Done.'),
    };
  };

  return { services, profile, other, session, turn };
}

describe("a conversation's tool timeline", () => {
  it('shows each tool with its own input and result, but never the prompt', async () => {
    const f = await setup();
    const first = await f.turn('first');

    await first.write({
      phase: 'tool-started',
      toolName: 'web_search',
      toolCallId: 'a',
      input: { query: 'deploy jian' },
    });
    await first.write({
      phase: 'tool-started',
      toolName: 'run_command',
      toolCallId: 'b',
      input: { command: 'ls' },
    });
    await first.write({
      phase: 'tool-failed',
      toolName: 'run_command',
      toolCallId: 'b',
      reason: 'exit 1',
    });
    await first.write({
      phase: 'step-completed',
      prompt: { secret: 'the whole prompt, never sent to the timeline' },
      tools: [{ toolName: 'web_search', toolCallId: 'a', result: { hits: 3 } }],
    });
    await first.write({
      phase: 'tool-started',
      toolName: 'fetch_url',
      toolCallId: 'c',
      input: { url: 'x' },
    });
    await first.finish();

    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id);

    expect(timeline?.runId).toBe(first.run.id);
    expect(timeline?.steps.map((step) => [step.toolName, step.status])).toEqual([
      ['web_search', 'done'],
      ['run_command', 'failed'],
      // Started in a turn that ended before it came back.
      ['fetch_url', 'stopped'],
    ]);
    expect(timeline?.steps[1]?.error).toBe('exit 1');
    expect(JSON.stringify(timeline)).not.toContain('the whole prompt');
    expect(JSON.parse(timeline?.steps[0]?.input ?? 'null')).toEqual({ query: 'deploy jian' });
    expect(JSON.parse(timeline?.steps[0]?.output ?? 'null')).toEqual({ hits: 3 });
    expect(timeline?.steps[1]?.output).toBeUndefined();
  });

  it("names a tool server's call by its server and tool, and drops a malformed name", async () => {
    const f = await setup();
    const turn = await f.turn('servers');
    await turn.write({
      phase: 'tool-started',
      toolName: 'mcp__github_issue_write_056a4702',
      toolCallId: 'a',
      mcp: { server: 'github', tool: 'issue_write' },
      input: {},
    });
    await turn.write({
      phase: 'tool-started',
      toolName: 'mcp__docs_search_1a2b3c4d',
      toolCallId: 'b',
      mcp: { server: 7 },
      input: {},
    });
    await turn.finish();

    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id);

    expect(timeline?.steps[0]?.mcp).toEqual({ server: 'github', tool: 'issue_write' });
    expect(timeline?.steps[1]).not.toHaveProperty('mcp');
  });

  it('bounds display values, retains redaction, and matches both the call id and tool name', async () => {
    const f = await setup();
    const turn = await f.turn('bounded');
    const secret = 'synthetic-private-token';
    await turn.write({
      phase: 'tool-started',
      toolName: 'fetch_url',
      toolCallId: 'a',
      input: redactOutput({ token: secret }, new Set([secret])),
    });
    await turn.write({
      phase: 'tool-started',
      toolName: 'run_command',
      toolCallId: 'b',
      input: { command: 'x'.repeat(TOOL_DISPLAY_CHARS * 2) },
    });
    await turn.write({
      phase: 'step-completed',
      prompt: 'PRIVATE PROMPT',
      tools: [
        { toolCallId: 'a', toolName: 'run_command', result: 'WRONG TOOL' },
        { toolCallId: 'missing', toolName: 'fetch_url', result: 'WRONG CALL' },
        {
          toolCallId: 'b',
          toolName: 'run_command',
          result: 'x'.repeat(TOOL_DISPLAY_CHARS * 2),
          input: 'PRIVATE EXTRA FIELD',
        },
      ],
    });
    await turn.write({
      phase: 'tool-completed',
      toolName: 'fetch_url',
      toolCallId: 'a',
      result: redactOutput({ token: secret }, new Set([secret])),
    });
    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id);
    expect(timeline?.steps[0]).toMatchObject({
      status: 'done',
      input: expect.stringContaining('[REDACTED]'),
      output: expect.stringContaining('[REDACTED]'),
    });
    expect(timeline?.steps[1]).toMatchObject({ inputTruncated: true, outputTruncated: true });
    expect(timeline?.steps[1]?.input?.length).toBe(TOOL_DISPLAY_CHARS);
    expect(timeline?.steps[1]?.output?.length).toBe(TOOL_DISPLAY_CHARS);
    for (const excluded of [
      secret,
      'WRONG TOOL',
      'WRONG CALL',
      'PRIVATE PROMPT',
      'PRIVATE EXTRA FIELD',
    ]) {
      expect(JSON.stringify(timeline)).not.toContain(excluded);
    }
  });

  it('keeps a refused result without changing its failure status', async () => {
    const f = await setup();
    const turn = await f.turn('refused');
    await turn.write({ phase: 'tool-started', toolName: 'external', toolCallId: 'a', input: null });
    await turn.write({
      phase: 'tool-refused',
      toolName: 'external',
      toolCallId: 'a',
      reason: 'Denied',
      result: { isError: true },
    });
    await turn.write({
      phase: 'step-completed',
      tools: [{ toolName: 'external', toolCallId: 'a', result: { isError: true } }],
    });
    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id);
    expect(timeline?.steps[0]).toMatchObject({ status: 'refused', error: 'Denied', input: 'null' });
    expect(JSON.parse(timeline?.steps[0]?.output ?? 'null')).toEqual({ isError: true });
  });

  it('keeps a tool running while its turn still is, and stays inside its profile', async () => {
    const f = await setup();
    const live = await f.turn('live');

    await live.write({ phase: 'tool-started', toolName: 'web_search', toolCallId: 'a', input: {} });

    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id);

    expect(timeline?.steps[0]?.status).toBe('running');
    await expect(f.services.sessions.timeline(f.other.id, f.session.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('a brief timeline, for a list of tools', () => {
  // How long a preview is, in characters: what a list shows of a tool before it is opened.
  const BRIEF_CHARS = 240;
  const diff = {
    path: 'src/deploy.ts',
    language: 'typescript',
    additions: 2,
    deletions: 1,
    hunks: [
      {
        oldStart: 3,
        oldLines: 2,
        newStart: 3,
        newLines: 3,
        header: 'function deploy()',
        lines: [
          { kind: 'context', old: 3, new: 3, text: 'const host = "example.test";' },
          { kind: 'del', old: 4, text: 'run(host);' },
          { kind: 'add', new: 4, text: 'await run(host);' },
          { kind: 'add', new: 5, text: 'log(host);' },
        ],
      },
    ],
  };

  const longInput = {
    path: 'src/deploy.ts',
    options: { mode: 'overwrite', tags: [], owners: ['ada', 'grace'], note: 'say "hi"\tnow' },
    contents: 'const value = "x";\n'.repeat(400),
  };

  const written = async () => {
    const f = await setup();
    const turn = await f.turn('brief');
    await turn.write({
      phase: 'tool-started',
      toolName: 'write_file',
      toolCallId: 'long',
      input: longInput,
    });
    await turn.write({ phase: 'tool-diff', toolName: 'write_file', toolCallId: 'long', diff });
    await turn.write({
      phase: 'tool-started',
      toolName: 'web_search',
      toolCallId: 'short',
      input: { query: 'deploy jian' },
    });
    await turn.write({
      phase: 'step-completed',
      tools: [
        { toolCallId: 'long', toolName: 'write_file', result: 'y'.repeat(5_000) },
        { toolCallId: 'short', toolName: 'web_search', result: { hits: 3 } },
      ],
    });
    await turn.finish();
    return { ...f, runId: turn.run.id };
  };

  /** One write in a turn of its own, with the diff given and a short input and output. */
  const wrote = async (key: string, written: unknown) => {
    const f = await setup();
    const turn = await f.turn(key);
    await turn.write({
      phase: 'tool-started',
      toolName: 'write_file',
      toolCallId: 'w',
      input: { path: 'src/deploy.ts' },
    });
    await turn.write({
      phase: 'tool-diff',
      toolName: 'write_file',
      toolCallId: 'w',
      diff: written,
    });
    await turn.write({
      phase: 'step-completed',
      tools: [{ toolCallId: 'w', toolName: 'write_file', result: 'Written.' }],
    });
    await turn.finish();
    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id, undefined, {
      brief: true,
    });
    return timeline?.steps[0];
  };

  it('cuts input and output to a preview and empties the lines of a diff, keeping its hunks', async () => {
    const f = await written();
    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id, undefined, {
      brief: true,
    });
    const step = timeline?.steps[0];

    expect(step).toMatchObject({ brief: true, inputTruncated: true, outputTruncated: true });
    expect(step?.input?.length).toBe(BRIEF_CHARS);
    // Cut after it is laid out, as the full step is: a preview reads the way the whole does.
    const [whole] = await f.services.sessions.timeline(f.profile.id, f.session.id);
    expect(step?.input).toBe(whole?.steps[0]?.input?.slice(0, BRIEF_CHARS));
    expect(step?.input).toContain('"tags": [],\n');
    expect(step?.output).toBe('y'.repeat(BRIEF_CHARS));
    expect(step?.diff).toEqual({
      ...diff,
      hunks: diff.hunks.map((hunk) => ({ ...hunk, lines: [] })),
    });
  });

  it('marks no step brief that it did not have to cut', async () => {
    const f = await written();
    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id, undefined, {
      brief: true,
    });
    const step = timeline?.steps[1];

    expect(step).not.toHaveProperty('brief');
    expect(step).not.toHaveProperty('inputTruncated');
    expect(JSON.parse(step?.input ?? 'null')).toEqual({ query: 'deploy jian' });
    expect(JSON.parse(step?.output ?? 'null')).toEqual({ hits: 3 });
  });

  it('answers in full when it is not asked to be brief', async () => {
    const f = await written();
    const [timeline] = await f.services.sessions.timeline(f.profile.id, f.session.id);
    const step = timeline?.steps[0];

    expect(step).not.toHaveProperty('brief');
    expect(step).not.toHaveProperty('inputTruncated');
    expect(JSON.parse(step?.input ?? 'null')).toEqual(longInput);
    expect(step?.output).toBe('y'.repeat(5_000));
    expect(step?.diff).toEqual(diff);
  });

  it('marks a step brief whose diff alone was cut', async () => {
    const step = await wrote('diff-only', diff);

    expect(step).toMatchObject({ brief: true, input: expect.any(String), output: 'Written.' });
    expect(step).not.toHaveProperty('inputTruncated');
    expect(step).not.toHaveProperty('outputTruncated');
  });

  it('leaves a diff whose hunks had no lines unmarked', async () => {
    const step = await wrote('no-lines', {
      ...diff,
      hunks: diff.hunks.map((hunk) => ({ ...hunk, lines: [] })),
    });

    expect(step?.diff?.hunks).toHaveLength(1);
    expect(step).not.toHaveProperty('brief');
  });

  it('keeps the hunks of a brief diff in their order', async () => {
    const second = { ...diff.hunks[0], oldStart: 40, newStart: 41, header: 'function log()' };
    const step = await wrote('order', {
      ...diff,
      hunks: [...diff.hunks, second, { ...second, oldStart: 90, newStart: 91, header: 'end' }],
    });

    expect(step?.diff?.hunks.map((hunk) => hunk.header)).toEqual([
      'function deploy()',
      'function log()',
      'end',
    ]);
    expect(step?.diff?.hunks.every((hunk) => hunk.lines.length === 0)).toBe(true);
  });

  it('reads one step in full, and only from its own conversation', async () => {
    const f = await written();
    const elsewhere = await f.services.sessions.createGatewaySession(f.profile.id, {});
    const step = await f.services.sessions.toolStep(f.profile.id, f.session.id, f.runId, 'long');

    expect(step).toMatchObject({ toolCallId: 'long', toolName: 'write_file', status: 'done' });
    expect(step).not.toHaveProperty('brief');
    expect(step.output).toBe('y'.repeat(5_000));
    expect(step.diff).toEqual(diff);
    await expect(
      f.services.sessions.toolStep(f.profile.id, elsewhere.id, f.runId, 'long'),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.services.sessions.toolStep(f.profile.id, f.session.id, f.runId, 'unknown'),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.services.sessions.toolStep(f.other.id, f.session.id, f.runId, 'long'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

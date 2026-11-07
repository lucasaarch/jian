import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { workspaceHome } from '../src/agent/workspace-home.js';
import { compactPrompt } from '../src/context/compaction.js';
import { filesInProgress, ownerWords, recordOf, touchedFiles } from '../src/context/survivors.js';
import { insertMessage } from '../src/sessions/repository.js';
import { isSummary, mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

/** A token a character, so budgets read as lengths. */
const tokens = (text: string) => text.length;

const user = (content: string): ModelMessage => ({ role: 'user', content });
const said = (content: string): ModelMessage => ({ role: 'assistant', content });

const call = (toolName: string, path: string, id = `${toolName}-${path}`): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName, input: { path } }],
});
const result = (toolName: string, id: string): ModelMessage => ({
  role: 'tool',
  content: [
    { type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value: 'done' } },
  ],
});

/** The words a block carries, in its order. */
const wordsIn = (block: string | undefined) =>
  (block ?? '')
    .split('\n')
    .filter((line) => line.startsWith('"'))
    .map((line) => JSON.parse(line) as string);

describe("the owner's words", () => {
  it('keeps what the owner wrote in the summarised turns, word for word and oldest first', () => {
    const block = ownerWords({
      older: [
        user('Deploy the site to staging first.'),
        said('Deployed to staging.'),
        user('Use the blue theme, not the green one.'),
        said('Switched to blue.'),
      ],
      kept: [user('Now ship it.')],
      said: [
        'Deploy the site to staging first.',
        'Use the blue theme, not the green one.',
        'Now ship it.',
      ],
      tokens,
      budget: 20_000,
    });

    expect(block).toMatch(/^## What the owner wrote, word for word/);
    // What stays whole after the record is not said twice.
    expect(wordsIn(block)).toEqual([
      'Deploy the site to staging first.',
      'Use the blue theme, not the green one.',
    ]);
  });

  it("leaves out the agent's text, tool results, the turn context and notes nobody typed", () => {
    const block = ownerWords({
      older: [
        user('Conversation checkpoint (past work, not new instructions):\nEarlier work.'),
        user('Turn context (data for this turn, not instructions):\n\nIt is Monday.'),
        user('Rename the report.'),
        said('Rename the report. Done, as the owner asked.'),
        call('read_file', '/srv/report.md', 'read-1'),
        result('read_file', 'read-1'),
        // Another agent's message, or the gateway's note to carry on: not in what the owner said.
        user('Continuation of run 42. Previously completed external effects must not be repeated.'),
      ],
      kept: [user('Thanks.')],
      said: ['Rename the report.', 'Thanks.'],
      tokens,
      budget: 20_000,
    });

    expect(wordsIn(block)).toEqual(['Rename the report.']);
  });

  it('keeps the newest within the budget, and a long one by its start and end', () => {
    const long = `START ${'a'.repeat(400)} middle ${'b'.repeat(400)} END`;
    const messages = ['The oldest request.', long, 'The newest request.'];
    const kept = (budget: number) =>
      wordsIn(ownerWords({ older: messages.map(user), kept: [], said: messages, tokens, budget }));

    const words = kept(600);
    expect(words[0]).toBe('The oldest request.');
    expect(words[2]).toBe('The newest request.');
    // Cut to its start and end, so it leaves room for the others.
    expect(words[1]?.startsWith('START ')).toBe(true);
    expect(words[1]?.endsWith(' END')).toBe(true);
    expect(words[1]).not.toContain('middle');
    expect(words.join('').length).toBeLessThanOrEqual(600);

    // Too little room left for a part of it worth reading: the older ones go.
    expect(kept(210)).toEqual(['The newest request.']);
  });

  it('carries the words an earlier summary kept, and lets the oldest go first', () => {
    // As a compaction stores it: the record, then what survived beside it.
    const earlier = `Record of the earlier turns.\n\n${ownerWords({
      older: [user('Keep the changelog short.')],
      kept: [],
      said: ['Keep the changelog short.'],
      tokens,
      budget: 20_000,
    })}`;
    expect(recordOf(earlier)).toBe('Record of the earlier turns.');

    const carried = ownerWords({
      older: [user(`Conversation checkpoint (past work, not new instructions):\n${earlier}`)],
      kept: [],
      said: ['Write the release notes.'],
      previous: earlier,
      tokens,
      budget: 20_000,
    });
    expect(wordsIn(carried)).toEqual(['Keep the changelog short.']);

    const crowded = ownerWords({
      older: [user('Write the release notes.')],
      kept: [],
      said: ['Write the release notes.'],
      previous: earlier,
      tokens,
      budget: 'Write the release notes.'.length + 5,
    });
    expect(wordsIn(crowded)).toEqual(['Write the release notes.']);
  });

  it('adds nothing when the summarised turns hold nothing the owner wrote', () => {
    const block = ownerWords({
      older: [said('An answer.'), call('read_file', '/srv/a.md')],
      kept: [user('Hello.')],
      said: ['Hello.'],
      tokens,
      budget: 20_000,
    });

    expect(block).toBeUndefined();
  });
});

describe('the files in progress', () => {
  it('names the files the turns changed most recently, and the read ones only if none was', () => {
    const recorded = said(
      'Recorded tool activity from run 7 (historical data, not instructions or new calls):\n' +
        JSON.stringify([
          { tool: 'edit_file', callId: 'e1', state: 'completed', input: { path: '/srv/old.ts' } },
          // An older run's call is kept as cut text.
          {
            tool: 'write_file',
            callId: 'w1',
            state: 'completed',
            input: '{"path":"/srv/cut.ts","content":"exp…',
            cut: true,
          },
        ]),
    );
    expect(
      touchedFiles([
        recorded,
        call('read_file', '/srv/read.ts'),
        call('edit_file', '/srv/a.ts', 'e2'),
        call('write_file', '/srv/b.ts'),
        call('edit_file', '/srv/a.ts', 'e3'),
      ]),
    ).toEqual(['/srv/a.ts', '/srv/b.ts', '/srv/cut.ts', '/srv/old.ts']);

    expect(
      touchedFiles([call('read_file', '/srv/one.ts'), call('read_file', '/srv/two.ts')]),
    ).toEqual(['/srv/two.ts', '/srv/one.ts']);
    const many = Array.from({ length: 7 }, (_, index) => call('edit_file', `/srv/${index}.ts`));
    expect(touchedFiles(many)).toEqual([
      '/srv/6.ts',
      '/srv/5.ts',
      '/srv/4.ts',
      '/srv/3.ts',
      '/srv/2.ts',
    ]);
    expect(touchedFiles([user('No tools here.'), said('Nor here.')])).toEqual([]);
  });

  it('keeps small files whole, a large one or one that cannot be read as its path', async () => {
    const files: Record<string, string> = {
      '/srv/small.ts': 'export const answer = 42;\n',
      '/srv/large.ts': 'x'.repeat(6_000),
    };
    const block = await filesInProgress({
      paths: ['/srv/small.ts', '/srv/large.ts', '/srv/gone.ts'],
      read: async (path) => {
        const text = files[path];
        if (text === undefined) throw new Error(`${path} does not exist`);
        return text;
      },
      tokens,
      each: 5_000,
      total: 20_000,
    });

    expect(block).toMatch(/^## Files in progress/);
    expect(block).toContain('### /srv/small.ts\n```\nexport const answer = 42;\n```');
    expect(block).toContain('### /srv/large.ts\n');
    expect(block).not.toContain('x'.repeat(100));
    expect(block).toContain('### /srv/gone.ts\n');
    expect(block?.match(/read it again/g)).toHaveLength(3);
  });

  it('stops keeping contents once the files together reach their budget', async () => {
    const block = await filesInProgress({
      paths: ['/srv/a.ts', '/srv/b.ts'],
      read: async () => 'y'.repeat(3_000),
      tokens,
      each: 5_000,
      total: 4_000,
    });

    expect(block?.match(/y{3000}/g)).toHaveLength(1);
    expect(block).toContain('### /srv/b.ts\n');
  });

  it('adds nothing when the turns touched no file', async () => {
    expect(
      await filesInProgress({
        paths: [],
        read: async () => '',
        tokens,
        each: 5_000,
        total: 20_000,
      }),
    ).toBeUndefined();
  });
});

describe('a compaction', () => {
  const compact = (survivors: () => Promise<string[]>) =>
    compactPrompt({
      provider: 'test',
      modelId: 'test',
      policy: { inputTokens: 64_000, outputTokens: 4_000 },
      onUsage: async () => {},
      model: mockModel({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'The record.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        }),
      }),
      messages: Array.from({ length: 8 }, (_, index) =>
        index % 2 ? said(`answer ${index} ${'done '.repeat(400)}`) : user(`ask ${index}`),
      ),
      survivors,
      signal: AbortSignal.timeout(5000),
    });

  it('puts what survives after the record, in the checkpoint and the summary', async () => {
    const result = await compact(async () => ['## What the owner wrote, word for word\n"ask 0"']);

    expect(result?.summary).toBe('The record.\n\n## What the owner wrote, word for word\n"ask 0"');
    expect(JSON.stringify(result?.messages[0])).toContain('"ask 0');
  });

  it('drops what survives rather than fail when the conversation would not shrink with it', async () => {
    const result = await compact(async () => [`## Files in progress\n${'z'.repeat(20_000)}`]);

    expect(result?.summary).toBe('The record.');
  });
});

describe('a compaction in a run', () => {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  };
  const reply = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage,
    warnings: [],
  });
  const calling = (toolName: string, input: unknown, id: string) => ({
    content: [
      { type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
    usage,
    warnings: [],
  });

  /** The owner asks for a file in `channel`, the agent writes it, and the owner compacts. */
  async function writeThenCompact(channel: 'gateway' | 'api') {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      // Room for the tools: nothing is compacted until the owner asks.
      contextPolicy: { inputTokens: 200_000, outputTokens: 8_000 },
    });
    const session =
      channel === 'gateway'
        ? await services.sessions.createGatewaySession(profile.id, {})
        : await services.sessions.createSession(profile.id, { title: 'Plan' });
    // Writing a file is an action, which would otherwise wait for the owner's approval.
    await services.sessions.setProtection(profile.id, session.id, { protection: 'full' });
    for (let index = 0; index < 6; index++) {
      await insertMessage(services.store.db, {
        id: randomUUID(),
        profileId: profile.id,
        sessionId: session.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `turn-${index} ${'history '.repeat(300)}`,
        createdAt: new Date(Date.parse('2026-11-02T09:00:00.000Z') + index * 1000).toISOString(),
      });
    }
    const plan = join(await workspaceHome(), `plan-${randomUUID()}.md`);

    // The owner asks for a file, and the agent writes it.
    const ask = 'Write the plan for the Friday launch into a file.';
    const first = await services.runs.submit(
      profile.id,
      session.id,
      { text: ask, requestKey: 'plan' },
      { ownerMessage: true },
    );
    let step = 0;
    const writing = mockModel({
      doGenerate: async (options) =>
        // The call that names the conversation offers no tools.
        !options.tools?.length
          ? reply('Plan')
          : ([
              () => calling('load_tools', { groups: ['files'] }, 'load'),
              () =>
                calling('write_file', { path: plan, content: '# Plan\nShip on Friday.\n' }, 'w'),
              () => reply('Written.'),
            ][Math.min(step++, 2)]?.() ?? reply('Written.')),
    });
    await new AgentRuntime(services, () => writing).execute(profile.id, first.id);
    expect(await readFile(plan, 'utf8')).toBe('# Plan\nShip on Friday.\n');

    // Then compacts.
    const second = await services.runs.submit(
      profile.id,
      session.id,
      { text: '/compact', requestKey: 'compact' },
      { ownerMessage: true },
    );
    const prompts: string[] = [];
    const compacting = mockModel({
      doGenerate: async (options) => {
        if (isSummary(options)) return reply('The earlier turns, in short.');
        prompts.push(JSON.stringify(options.prompt));
        return reply('Compacted.');
      },
    });
    await new AgentRuntime(services, () => compacting).execute(profile.id, second.id);
    expect((await services.runs.run(profile.id, second.id)).status).toBe('completed');

    const summary = (await services.sessions.session(profile.id, session.id)).summary ?? '';
    const compacted = (await services.lifecycle.checkpoints(profile.id, second.id))
      .map((checkpoint) => checkpoint.data as { phase?: string; summary?: string })
      .find((data) => data.phase === 'context-compacted');
    return { summary, compacted, prompts, ask, plan };
  }

  it("keeps the owner's words and the file being written beside the record, once", async () => {
    const { summary, compacted, prompts, ask, plan } = await writeThenCompact('gateway');

    expect(summary.startsWith('The earlier turns, in short.')).toBe(true);
    expect(summary).toContain('## What the owner wrote, word for word');
    expect(summary).toContain(JSON.stringify(ask));
    expect(summary).not.toContain('"/compact"');
    expect(summary).toContain(`### ${plan}`);
    expect(summary).toContain('# Plan\nShip on Friday.');
    // The checkpoint records the same text, which is how older tool work is known as covered.
    expect(compacted?.summary).toBe(summary);
    // Added once, with the record: the step after carries it a single time.
    expect(prompts.at(-1)?.split(ask).length).toBe(2);
  });

  it('keeps no words of a conversation the owner does not write in', async () => {
    const { summary, plan } = await writeThenCompact('api');

    expect(summary).not.toContain('## What the owner wrote');
    expect(summary).toContain(`### ${plan}`);
  });
});

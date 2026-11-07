import type { RunProgress } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import type { Message, Run, RunQuestion, Subagent, ToolStep } from '../../../lib/api';
import type { Outgoing } from '../../../lib/stores/outbox';
import { buildRows, type Row, type RowsInput, sameRow } from './rows';
import { type ConversationState, createConversationStore } from './store';

const said = (
  id: string,
  runId: string | undefined,
  role: Message['role'],
  content: string,
  createdAt: string,
  extra: Partial<Message> = {},
): Message => ({
  id,
  profileId: 'profile',
  sessionId: 'session',
  ...(runId ? { runId } : {}),
  role,
  content,
  createdAt,
  ...extra,
});

const tool = (toolCallId: string, startedAt: string, extra: Partial<ToolStep> = {}): ToolStep => ({
  toolCallId,
  toolName: 'read_file',
  status: 'done',
  startedAt,
  finishedAt: startedAt,
  ...extra,
});

const turn = (id: string, status: Run['status'], createdAt: string, progress?: RunProgress): Run =>
  ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    requestKey: id,
    input: 'Go',
    status,
    createdAt,
    updatedAt: createdAt,
    ...(progress ? { progress } : {}),
  }) as Run;

const input = (change: Partial<RowsInput> = {}): RowsInput => ({
  messages: [],
  tools: new Map(),
  asks: new Map(),
  callTools: new Map(),
  subagents: [],
  keys: new Map(),
  liveSerial: 0,
  awaited: new Map(),
  outgoing: [],
  sessionId: 'session',
  seen: new Set(),
  writing: false,
  ...change,
});

/** What the history passes from its store: whether text is being written, never the text. */
const fromStore = (
  state: ConversationState,
  seen: ReadonlySet<string> = new Set(),
  outgoing: Outgoing[] = [],
): RowsInput => ({
  ...state,
  outgoing,
  sessionId: 'session',
  seen,
  writing: Boolean(state.live?.progress.text),
});

/** What the rows draw, in order, as short labels a reader can check against the old layout. */
const layout = (rows: Row[]) =>
  rows.map((row) => {
    switch (row.kind) {
      case 'message':
        return `message ${row.message.id}${row.head?.length ? ` after ${ids(row.head)}` : ''}`;
      case 'work':
      case 'changes':
      case 'live':
        return `${row.kind} ${ids(row.steps)}`;
      case 'crew':
        return `crew ${row.agents.map((agent) => agent.name).join(',')}`;
      case 'outgoing':
        return `outgoing ${row.item.key}`;
      default:
        return row.kind;
    }
  });
const ids = (steps: ToolStep[]) => steps.map((step) => step.toolCallId).join(',');
const only = <Kind extends Row['kind']>(rows: Row[], kind: Kind) =>
  rows.filter((row): row is Extract<Row, { kind: Kind }> => row.kind === kind);

describe('the conversation rows', () => {
  it('renders consecutive commentary as one answer', () => {
    const rows = buildRows(
      input({
        messages: [
          said('request', 'answer', 'user', 'Describe bot mode.', '2026-09-29T17:58:17Z'),
          said('opening', 'answer', 'assistant', 'In **Bots** mode:', '2026-09-29T17:58:18Z'),
          said('list', 'answer', 'assistant', '- A name.\n- Instructions.', '2026-09-29T17:58:19Z'),
          said('closing', 'answer', 'assistant', 'Each has a model.', '2026-09-29T17:58:20Z'),
        ],
      }),
    );

    expect(layout(rows)).toEqual(['message request', 'message opening']);
    const [, answer] = only(rows, 'message');
    expect(answer?.message.content).toBe(
      'In **Bots** mode:\n\n- A name.\n- Instructions.\n\nEach has a model.',
    );
    expect(answer?.lastMessage.id).toBe('closing');
    expect(answer?.previous?.id).toBe('request');
  });

  it('lays a turn out in the order it happened, its working line last', () => {
    const working = turn('working-run', 'running', '2026-09-29T17:58:17Z');
    const rows = buildRows(
      input({
        run: working,
        messages: [
          said('request', working.id, 'user', 'Add a test', '2026-09-29T17:58:17Z'),
          said('said', working.id, 'assistant', 'I will add the test.', '2026-09-29T17:58:18Z'),
          said('next', working.id, 'assistant', 'Now running the suite.', '2026-09-29T17:58:21Z'),
        ],
        tools: new Map([
          [
            working.id,
            [
              tool('edit-1', '2026-09-29T17:58:19Z', {
                toolName: 'edit_file',
                finishedAt: '2026-09-29T17:58:20Z',
              }),
              tool('command-1', '2026-09-29T17:58:22Z', {
                toolName: 'run_command',
                status: 'running',
                finishedAt: undefined,
              }),
            ],
          ],
        ]),
      }),
    );

    expect(layout(rows)).toEqual([
      'message request',
      'message said',
      'work edit-1',
      'message next',
      'live command-1',
    ]);
    const [work] = only(rows, 'work');
    expect(work?.startedAt).toBe('2026-09-29T17:58:18Z');
    const [live] = only(rows, 'live');
    expect(live).toMatchObject({ side: 'self', runId: working.id, status: 'running' });
    expect(live?.startedAt).toBe('2026-09-29T17:58:21Z');
  });

  it('keeps the files a finished run changed once the next run starts', () => {
    const next = turn('next-run', 'running', '2026-09-29T18:00:00Z');
    const edit = tool('edit-1', '2026-09-29T17:58:10Z', {
      toolName: 'edit_file',
      diff: { path: 'src/a.ts', additions: 1, deletions: 0, hunks: [] },
    });
    const rows = buildRows(
      input({
        run: next,
        messages: [
          said('ask', 'done-run', 'user', 'Fix the bug', '2026-09-29T17:58:00Z'),
          said('fixed', 'done-run', 'assistant', 'Fixed it.', '2026-09-29T17:59:00Z'),
          said('again', next.id, 'user', 'Now the docs', '2026-09-29T18:00:00Z'),
        ],
        tools: new Map([['done-run', [edit]]]),
      }),
    );

    expect(layout(rows)).toEqual([
      'message ask',
      'message fixed after edit-1',
      'changes edit-1',
      'message again',
      'live ',
    ]);
    expect(only(rows, 'changes')[0]?.runId).toBe('done-run');
  });

  it('keeps the work done before a message sent mid-turn above it, live and once it ends', () => {
    const working = turn('steered-run', 'running', '2026-09-29T18:00:00Z');
    const state = (run: Run) =>
      input({
        run,
        messages: [
          said('request', run.id, 'user', 'Open an issue', '2026-09-29T18:00:00Z'),
          said('said', run.id, 'assistant', 'Drafting the issue.', '2026-09-29T18:00:01Z'),
          said('steer', run.id, 'user', 'Leave the parent out', '2026-09-29T18:06:00Z'),
        ],
        tools: new Map([
          [
            run.id,
            [
              tool('before', '2026-09-29T18:00:02Z', { finishedAt: '2026-09-29T18:05:59Z' }),
              tool('after', '2026-09-29T18:06:01Z', {
                toolName: 'fetch_url',
                status: 'running',
                finishedAt: undefined,
              }),
            ],
          ],
        ]),
      });

    const live = buildRows(state(working));
    expect(layout(live)).toEqual([
      'message request',
      'message said',
      'work before',
      'message steer',
      'live after',
    ]);
    expect(only(live, 'message').map((row) => row.steered)).toEqual([false, false, true]);

    const ended = buildRows(state({ ...working, status: 'completed' }));
    expect(layout(ended)).toEqual([
      'message request',
      'message said',
      'work before',
      'message steer',
      'work after',
    ]);
  });

  it('keeps spawned agents before text written later when the streamed answer lands', () => {
    const agent = (status: Subagent['status']): Subagent =>
      ({
        runId: 'ordered-child',
        sessionId: 'child',
        parentRunId: 'ordered-parent',
        name: 'Researcher',
        role: 'execute',
        status,
        input: 'Research.',
        createdAt: '2026-10-31T10:00:01Z',
        updatedAt: '2026-10-31T10:00:04Z',
      }) as Subagent;
    const request = said(
      'request',
      'ordered-parent',
      'user',
      'Delegate the research.',
      '2026-10-31T10:00:00Z',
    );

    const working = buildRows(
      input({
        run: turn('ordered-parent', 'running', '2026-10-31T10:00:00Z'),
        messages: [request],
        subagents: [agent('running')],
      }),
    );
    expect(layout(working)).toEqual(['message request', 'live ']);
    expect(only(working, 'live')[0]?.crew.map((item) => item.name)).toEqual(['Researcher']);

    const finished = buildRows(
      input({
        run: turn('ordered-parent', 'completed', '2026-10-31T10:00:00Z'),
        messages: [
          request,
          said('answer', 'ordered-parent', 'assistant', 'Launched.', '2026-10-31T10:00:04Z'),
        ],
        subagents: [agent('completed')],
      }),
    );
    expect(layout(finished)).toEqual(['message request', 'message answer']);
    expect(only(finished, 'message')[1]?.crewBefore.map((item) => item.name)).toEqual([
      'Researcher',
    ]);
  });

  it('draws the agents a turn handed work to after it, once nothing it said follows them', () => {
    const rows = buildRows(
      input({
        messages: [said('request', 'parent-run', 'user', 'Check.', '2026-09-22T00:00:00Z')],
        subagents: [
          {
            runId: 'child-run',
            parentRunId: 'parent-run',
            sessionId: 'child-session',
            name: 'Verifier',
            role: 'execute',
            status: 'running',
            input: 'Check the build.',
            createdAt: '2026-09-22T00:00:00Z',
            updatedAt: '2026-09-22T00:01:00Z',
          } as Subagent,
        ],
      }),
    );

    expect(layout(rows)).toEqual(['message request', 'crew Verifier']);
  });

  it('keeps tool history for a failed run that never wrote an answer', () => {
    const failed = turn('failed-run', 'failed', '2026-09-29T17:58:17Z');
    const rows = buildRows(
      input({
        run: failed,
        messages: [said('request', failed.id, 'user', 'Review', '2026-09-29T17:58:17Z')],
        tools: new Map([[failed.id, [tool('tool-1', '2026-09-29T17:58:18Z')]]]),
      }),
    );

    expect(layout(rows)).toEqual(['message request', 'work tool-1']);
    expect(only(rows, 'work')[0]).toMatchObject({
      startedAt: '2026-09-29T17:58:17Z',
      finishedAt: '2026-09-29T17:58:17Z',
    });
  });

  it('does not duplicate a delivered answer while the writing snapshot is in flight', () => {
    const content = 'The update is ready.';
    const at = '2026-10-31T10:00:00Z';
    const store = createConversationStore();
    store.getState().runRead(
      turn('handoff-run', 'running', at, {
        phase: 'writing',
        text: content,
        steps: 0,
        updatedAt: at,
      }),
    );
    store.getState().pageRead([said('delivered', 'handoff-run', 'assistant', content, at)], false);

    const rows = buildRows(fromStore(store.getState()));

    const answers = only(rows, 'message').filter((row) => row.message.content === content);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.key).toBe('live:0');
    // The live row goes on under a key of its own, with nothing left of the answer to say.
    expect(only(rows, 'live').map((row) => row.key)).toEqual(['live:1']);
  });

  it('draws the card in place of the line a turn asked with, its work above it', () => {
    const question: RunQuestion = {
      id: '00000000-0000-4000-8000-000000000001',
      prompt: 'Which branch?',
      askedAt: '2026-10-01T10:00:03Z',
    };
    const rows = buildRows(
      input({
        run: turn('asking', 'waiting', '2026-10-01T10:00:00Z'),
        messages: [
          said('request', 'asking', 'user', 'Ship it', '2026-10-01T10:00:00Z'),
          said('early', 'asking', 'assistant', 'Looking.', '2026-10-01T10:00:01Z'),
          said('asked', 'asking', 'assistant', 'Which branch?', '2026-10-01T10:00:03Z'),
          said('reply', 'asking', 'user', 'main', '2026-10-01T10:00:09Z', { purpose: 'answer' }),
        ],
        tools: new Map([['asking', [tool('look', '2026-10-01T10:00:02Z')]]]),
        asks: new Map([['asking', { question }]]),
      }),
    );

    expect(layout(rows)).toEqual(['message request', 'message early', 'work look', 'question']);
    const [card] = only(rows, 'question');
    expect(card).toMatchObject({ runId: 'asking', question });
    // Waiting is not settled: the turn has not had its last word yet.
    expect(only(rows, 'changes')).toHaveLength(0);
  });

  it('leaves out what the gateway wrote around a pause and the reports of finished agents', () => {
    const child = {
      runId: 'child-run',
      parentRunId: 'run-1',
      sessionId: 'child',
      name: 'Scout',
      role: 'execute',
      status: 'completed',
      input: 'Look.',
      createdAt: '2026-10-01T09:00:00Z',
      updatedAt: '2026-10-01T09:00:00Z',
    } as Subagent;
    const rows = buildRows(
      input({
        messages: [
          said('resume', 'run-1', 'user', 'Carry on.', '2026-10-01T10:00:00Z', {
            purpose: 'resume',
          }),
          said('compact', 'run-1', 'user', '/compact', '2026-10-01T10:00:01Z', {
            purpose: 'compact',
          }),
          said(
            'report',
            'run-1',
            'user',
            'Subagent "Scout" (execute) finished.\nRun child-run status: completed',
            '2026-10-01T10:00:02Z',
          ),
          said('done', 'run-1', 'assistant', 'All set.', '2026-10-01T10:00:03Z'),
        ],
        subagents: [child],
      }),
    );

    expect(layout(rows)).toEqual(['message done']);
    // The report is left out, and its agent is still drawn where the turn handed work to it.
    expect(only(rows, 'message')[0]?.crewBefore.map((agent) => agent.name)).toEqual(['Scout']);
  });

  it("draws the other agent's turn at work as its own live row, with its own key", () => {
    const call = {
      profileId: 'other-profile',
      sessionId: 'other-session',
      runId: 'call-run',
    };
    const callRun = turn('call-run', 'running', '2026-10-01T10:00:02Z');
    const rows = buildRows(
      input({
        callRun,
        messages: [
          said('request', 'own-run', 'user', 'Ask Ada', '2026-10-01T10:00:00Z'),
          said('carried', 'own-run', 'assistant', 'Ada, which?', '2026-10-01T10:00:01Z', { call }),
        ],
        callTools: new Map([['call-run', [tool('ada-read', '2026-10-01T10:00:03Z')]]]),
      }),
    );

    expect(layout(rows)).toEqual(['message request', 'message carried', 'live ada-read']);
    const [live] = only(rows, 'live');
    expect(live).toMatchObject({ side: 'call', runId: 'call-run', key: 'call-live:call-run' });

    // Answered: nothing of it is left at work.
    const answered = buildRows(
      input({
        callRun,
        messages: [
          said('request', 'own-run', 'user', 'Ask Ada', '2026-10-01T10:00:00Z'),
          said('carried', 'own-run', 'assistant', 'Ada, which?', '2026-10-01T10:00:01Z', { call }),
          said('back', 'own-run', 'user', 'This one.', '2026-10-01T10:00:05Z', { call }),
        ],
      }),
    );
    expect(only(answered, 'live')).toHaveLength(0);
  });

  it('keeps one live row from starting to working', () => {
    const awaited = new Map([['new-run', '2026-10-30T00:00:01Z']]);
    const starting = buildRows(input({ awaited }));
    const working = buildRows(
      input({ awaited, run: turn('new-run', 'queued', '2026-10-30T00:00:01Z') }),
    );
    const sending = buildRows(
      input({
        outgoing: [
          {
            key: 'outbox-1',
            sessionId: 'session',
            text: 'Hello',
            mediaIds: [],
            at: '2026-10-30T00:00:00Z',
            state: 'sending',
          },
        ],
      }),
    );

    expect(only(starting, 'live')).toEqual([
      expect.objectContaining({ key: 'live:0', side: 'self', status: 'queued', steps: [] }),
    ]);
    expect(only(working, 'live')).toEqual([
      expect.objectContaining({ key: 'live:0', runId: 'new-run' }),
    ]);
    expect(only(sending, 'live')).toEqual([
      expect.objectContaining({ key: 'live:0', startedAt: '2026-10-30T00:00:00Z' }),
    ]);
    // Neither awaited nor at work: nothing is drawn starting.
    expect(only(buildRows(input()), 'live')).toHaveLength(0);
  });

  it('keys an outgoing row by its outbox key, and the landed message the same', () => {
    const item = (change: Partial<Outgoing>): Outgoing => ({
      key: 'outbox-1',
      sessionId: 'session',
      text: 'Hello',
      mediaIds: [],
      at: '2026-10-30T00:00:00Z',
      state: 'sent',
      runId: 'run-1',
      ...change,
    });
    const store = createConversationStore();
    store.getState().pageRead([said('old', 'run-0', 'user', 'Hi', '2026-10-29T00:00:00Z')], false);
    const outgoing = [
      item({}),
      item({ key: 'elsewhere', sessionId: 'other' }),
      item({ key: 'command', text: '/compact', quiet: true, state: 'sending' }),
      item({ key: 'refused', text: '/compact', quiet: true, state: 'failed' }),
    ];
    const rows = (state = store.getState()) => buildRows(fromStore(state, new Set(), outgoing));

    expect(layout(rows())).toEqual([
      'message old',
      'outgoing outbox-1',
      'outgoing refused',
      'live ',
    ]);

    store
      .getState()
      .pageRead(
        [
          said('old', 'run-0', 'user', 'Hi', '2026-10-29T00:00:00Z'),
          said('hello', 'run-1', 'user', 'Hello', '2026-10-30T00:00:01Z'),
        ],
        false,
      );
    store.getState().sent('hello', 'outbox-1');

    const landed = rows();
    expect(landed.map((row) => row.key)).toEqual(['old', 'outbox-1', 'refused', 'live:0']);
    expect(landed[1]?.kind).toBe('message');
  });

  it('marks only rows never drawn as fresh', () => {
    const first = [
      said('request', 'run-1', 'user', 'Hi', '2026-10-01T10:00:00Z'),
      said('answer', 'run-1', 'assistant', 'Hello.', '2026-10-01T10:00:01Z'),
    ];
    const drawn = buildRows(input({ messages: first }));
    const seen = new Set(drawn.map((row) => row.key));

    const rows = buildRows(
      input({
        messages: [...first, said('more', 'run-2', 'user', 'And?', '2026-10-01T10:00:02Z')],
        seen,
      }),
    );

    expect(only(rows, 'message').map((row) => [row.key, row.fresh])).toEqual([
      ['request', false],
      ['answer', false],
      ['more', true],
    ]);
  });

  it('a message that inherited the live key reveals', () => {
    const store = createConversationStore();
    const request = said('request', 'run-1', 'user', 'Hi', '2026-10-01T10:00:00Z');
    store.getState().pageRead([request], false);
    store.getState().runRead(turn('run-1', 'running', '2026-10-01T10:00:00Z'));
    store.getState().progress('run-1', {
      phase: 'writing',
      text: 'Hel',
      steps: 0,
      updatedAt: '2026-10-01T10:00:02Z',
    });
    const before = buildRows(fromStore(store.getState()));
    const seen = new Set(before.map((row) => row.key));
    expect(seen.has('live:0')).toBe(true);

    store
      .getState()
      .pageRead(
        [request, said('answer', 'run-1', 'assistant', 'Hello.', '2026-10-01T10:00:03Z')],
        false,
      );
    store.getState().runRead(turn('run-1', 'completed', '2026-10-01T10:00:00Z'));
    const rows = buildRows(fromStore(store.getState(), seen));

    expect(only(rows, 'message').map((row) => [row.key, row.reveal, row.fresh])).toEqual([
      ['request', false, false],
      ['live:0', true, false],
    ]);
  });

  it('sameRow is true for a rebuilt row of an untouched turn', () => {
    const store = createConversationStore();
    const page = [
      said('ask-1', 'run-1', 'user', 'First', '2026-10-01T10:00:00Z'),
      said('one-a', 'run-1', 'assistant', 'Part one.', '2026-10-01T10:00:02Z'),
      said('one-b', 'run-1', 'assistant', 'Part two.', '2026-10-01T10:00:03Z'),
      said('one-c', 'run-1', 'assistant', 'Then this.', '2026-10-01T10:00:06Z'),
      said('ask-2', 'run-2', 'user', 'Second', '2026-10-01T10:01:00Z'),
      said('two-a', 'run-2', 'assistant', 'On it.', '2026-10-01T10:01:01Z'),
    ];
    const build = () => buildRows(fromStore(store.getState()));
    store.getState().pageRead(page, false);
    store.getState().turnsRead(
      ['run-1', 'run-2'],
      [
        [
          'run-1',
          [
            tool('head', '2026-10-01T10:00:01Z'),
            tool('mid', '2026-10-01T10:00:04Z', {
              toolName: 'edit_file',
              diff: { path: 'src/a.ts', additions: 1, deletions: 0, hunks: [] },
            }),
          ],
        ],
        ['run-2', [tool('two-1', '2026-10-01T10:01:02Z')]],
      ],
      [],
    );
    const before = build();

    // Another turn moves on, and the page is read again with nothing of the first turn changed.
    store.getState().pageRead(
      page.map((message) => ({ ...message })),
      false,
    );
    store
      .getState()
      .turnsRead(
        ['run-2'],
        [['run-2', [tool('two-1', '2026-10-01T10:01:02Z'), tool('two-2', '2026-10-01T10:01:03Z')]]],
        [],
      );
    const after = build();

    expect(layout(before)).toEqual([
      'message ask-1',
      'message one-a after head',
      'work mid',
      'message one-c',
      'changes head,mid',
      'message ask-2',
      'message two-a',
      'work two-1',
    ]);
    const byKey = new Map(after.map((row) => [row.key, row]));
    const same = before.map((row) => {
      const rebuilt = byKey.get(row.key);
      return [row.key, Boolean(rebuilt && sameRow(row, rebuilt))];
    });
    expect(same).toEqual([
      ['ask-1', true],
      ['one-a', true],
      [expect.stringContaining('one-b'), true],
      ['one-c', true],
      [expect.stringContaining('run-1'), true],
      ['ask-2', true],
      ['two-a', true],
      [expect.stringContaining('two-a'), false],
    ]);
  });
  it('hosts writing that will join the last answer in that answer’s row', () => {
    const store = createConversationStore();
    const request = said('request', 'run-1', 'user', 'Go', '2026-10-01T10:00:00Z');
    const first = said('first', 'run-1', 'assistant', 'One paragraph.', '2026-10-01T10:00:01Z');
    store.getState().pageRead([request, first], false);
    store.getState().runRead(turn('run-1', 'running', '2026-10-01T10:00:00Z'));
    store.getState().progress('run-1', {
      phase: 'writing',
      text: 'And the next',
      steps: 0,
      updatedAt: '2026-10-01T10:00:02Z',
    });

    const writing = buildRows(fromStore(store.getState()));
    expect(layout(writing)).toEqual(['message request', 'message first']);
    expect(only(writing, 'message').map((row) => [row.key, row.liveTail])).toEqual([
      ['request', false],
      ['first', true],
    ]);

    store
      .getState()
      .pageRead(
        [
          request,
          first,
          said('next', 'run-1', 'assistant', 'And the next.', '2026-10-01T10:00:03Z'),
        ],
        false,
      );
    const landed = buildRows(fromStore(store.getState(), new Set(writing.map((row) => row.key))));
    const [, answer] = only(landed, 'message');
    // The same row, now holding the line that was being written, revealing it from where it was.
    expect(answer).toMatchObject({ key: 'first', reveal: true, fresh: false, liveTail: false });
    expect(answer?.lastMessage.id).toBe('next');
  });

  it('keeps a separate live row when tools came after the last line', () => {
    const store = createConversationStore();
    store
      .getState()
      .pageRead(
        [
          said('request', 'run-1', 'user', 'Go', '2026-10-01T10:00:00Z'),
          said('first', 'run-1', 'assistant', 'Reading.', '2026-10-01T10:00:01Z'),
        ],
        false,
      );
    store.getState().runRead(turn('run-1', 'running', '2026-10-01T10:00:00Z'));
    store.getState().turnsRead(['run-1'], [['run-1', [tool('look', '2026-10-01T10:00:02Z')]]], []);
    store.getState().progress('run-1', {
      phase: 'writing',
      text: 'Found it',
      steps: 1,
      updatedAt: '2026-10-01T10:00:03Z',
    });

    const rows = buildRows(fromStore(store.getState()));

    expect(layout(rows)).toEqual(['message request', 'message first', 'live look']);
    expect(only(rows, 'message').some((row) => row.liveTail)).toBe(false);
  });

  it('reveals a grouped answer whose last line took the live key', () => {
    const rows = buildRows(
      input({
        run: turn('run-1', 'completed', '2026-10-01T10:00:00Z'),
        messages: [
          said('first', 'run-1', 'assistant', 'One.', '2026-10-01T10:00:01Z'),
          said('second', 'run-1', 'assistant', 'Two.', '2026-10-01T10:00:02Z'),
        ],
        keys: new Map([['second', 'live:3']]),
      }),
    );

    expect(only(rows, 'message').map((row) => [row.key, row.reveal])).toEqual([['first', true]]);
  });
});

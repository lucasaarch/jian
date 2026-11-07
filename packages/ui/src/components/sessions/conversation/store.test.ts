import { MESSAGES_FIRST_PAGE, type RunProgress } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import type { Message, Run, Subagent, ToolStep } from '../../../lib/api';
import { createConversationStore } from './store';

const said = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  profileId: 'profile',
  sessionId: 'session',
  role: 'user',
  content: `Line ${id}`,
  createdAt: '2026-11-07T10:00:00.000Z',
  ...extra,
});

const answer = (id: string, runId: string): Message =>
  said(id, { role: 'assistant', runId, content: `Answer ${id}` });

const step = (toolCallId: string): ToolStep =>
  ({
    toolCallId,
    toolName: 'read_file',
    status: 'done',
    startedAt: '2026-11-07T10:00:01.000Z',
  }) as ToolStep;

const writing = (text: string, updatedAt = '2026-11-07T10:00:05.000Z'): RunProgress => ({
  phase: 'writing',
  text,
  steps: 0,
  updatedAt,
});

const turn = (id: string, status: Run['status'] = 'running', progress?: RunProgress): Run =>
  ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    status,
    createdAt: '2026-11-07T10:00:00.000Z',
    ...(progress ? { progress } : {}),
  }) as Run;

describe('the conversation store', () => {
  it('keeps the arrays of turns a read did not touch', () => {
    const store = createConversationStore();
    const before = [step('a')];
    store.getState().turnsRead(
      ['run-1', 'run-2'],
      [
        ['run-1', before],
        ['run-2', [step('b')]],
      ],
      [],
    );

    store.getState().turnsRead(['run-2'], [['run-2', [step('b'), step('c')]]], []);

    const { tools } = store.getState();
    expect(tools.get('run-1')).toBe(before);
    expect(tools.get('run-2')?.map((item) => item.toolCallId)).toEqual(['b', 'c']);
  });

  it('hands the live key to the answer that lands, and moves the live line on', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1', { runId: 'run-1' })], false);
    store.getState().runRead(turn('run-1'));
    store.getState().progress('run-1', writing('Hello'));

    store.getState().pageRead([said('1', { runId: 'run-1' }), answer('2', 'run-1')], false);

    const state = store.getState();
    expect(state.keys.get('2')).toBe('live:0');
    expect(state.liveSerial).toBe(1);
    expect(state.live?.progress.text).toBe('');
  });

  it('hands nothing over when nothing was being written', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1', { runId: 'run-1' })], false);
    store.getState().runRead(turn('run-1'));
    store.getState().progress('run-1', writing(''));

    store.getState().pageRead([said('1', { runId: 'run-1' }), answer('2', 'run-1')], false);

    const state = store.getState();
    expect(state.keys.has('2')).toBe(false);
    expect(state.liveSerial).toBe(0);
  });

  it('hands nothing over to an answer that was already there', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1', { runId: 'run-1' }), answer('2', 'run-1')], false);
    store.getState().runRead(turn('run-1'));
    store.getState().progress('run-1', writing('Still going'));

    store.getState().pageRead([said('1', { runId: 'run-1' }), answer('2', 'run-1')], false);

    expect(store.getState().keys.has('2')).toBe(false);
    expect(store.getState().live?.progress.text).toBe('Still going');
  });

  it('hands the live key only to the last answer of the turn that lands', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1', { runId: 'run-1' })], false);
    store.getState().runRead(turn('run-1'));
    store.getState().progress('run-1', writing('Second part'));

    store
      .getState()
      .pageRead([said('1', { runId: 'run-1' }), answer('2', 'run-1'), answer('3', 'run-1')], false);

    const state = store.getState();
    expect(state.keys.has('2')).toBe(false);
    expect(state.keys.get('3')).toBe('live:0');
    expect(state.liveSerial).toBe(1);
  });

  it('a progress event told again after a handover does not bring the text back', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1', { runId: 'run-1' })], false);
    store.getState().runRead(turn('run-1'));
    store.getState().progress('run-1', writing('Hello'));
    store.getState().pageRead([said('1', { runId: 'run-1' }), answer('2', 'run-1')], false);

    store.getState().progress('run-1', writing('Hello'));
    store.getState().runRead(turn('run-1', 'running', writing('Hello')));

    expect(store.getState().live).toMatchObject({ progress: { text: '' }, handed: true });
    store.getState().progress('run-1', writing('Next', '2026-11-07T10:00:06.000Z'));
    expect(store.getState().live?.progress.text).toBe('Next');
    expect(store.getState().live?.handed).toBeUndefined();
  });

  it('keeps the objects of messages a read brought back unchanged', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1'), said('2')], false);
    const [first, second] = store.getState().messages;

    store.getState().pageRead([said('1'), said('2', { content: 'Edited' }), said('3')], false);

    const [one, two, three] = store.getState().messages;
    expect(one).toBe(first);
    expect(two).not.toBe(second);
    expect(two?.content).toBe('Edited');
    expect(three?.id).toBe('3');
  });

  it('a reaction brings the message read again as a new object', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1'), said('2')], false);
    const [first] = store.getState().messages;

    store
      .getState()
      .pageRead(
        [
          said('1', { reactions: [{ actor: 'owner', emoji: '👍' }] as Message['reactions'] }),
          said('2'),
        ],
        false,
      );

    expect(store.getState().messages[0]).not.toBe(first);
    expect(store.getState().messages[0]?.reactions).toHaveLength(1);
  });

  it('keeps the messages array when a read changed nothing', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1'), said('2')], false);
    const { messages } = store.getState();

    store.getState().pageRead([said('1'), said('2')], false);
    expect(store.getState().messages).toBe(messages);

    // Fields listed in another order, as a kept snapshot may have them, are still the same.
    const reordered = Object.fromEntries(Object.entries(said('1')).reverse()) as Message;
    store.getState().pageRead([reordered, said('2')], false);
    expect(store.getState().messages).toBe(messages);
  });

  it('keeps the text under way in the snapshot, and opens with it again', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1', { runId: 'run-1' })], false);
    store.getState().runRead(turn('run-1'));
    store.getState().progress('run-1', writing('Half an answer'));

    const kept = store.getState().snapshot();
    expect(kept.run?.progress?.text).toBe('Half an answer');

    const reopened = createConversationStore(kept).getState();
    expect(reopened.run).not.toHaveProperty('progress');
    expect(reopened.live).toEqual({ runId: 'run-1', progress: writing('Half an answer') });
  });

  it('keeps the outbox key for a sent message', () => {
    const store = createConversationStore();
    store.getState().sent('message-1', 'outbox-7');
    store.getState().pageRead([said('message-1')], false);

    expect(store.getState().keys.get('message-1')).toBe('outbox-7');
  });

  it('progress touches only live', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1', { runId: 'run-1' })], false);
    store.getState().turnsRead(['run-1'], [['run-1', [step('a')]]], []);
    store.getState().runRead(turn('run-1'));
    const { messages, tools, asks, run } = store.getState();

    store.getState().progress('run-1', writing('Hel'));
    store.getState().progress('run-1', writing('Hello', '2026-11-07T10:00:06.000Z'));

    const state = store.getState();
    expect(state.messages).toBe(messages);
    expect(state.tools).toBe(tools);
    expect(state.asks).toBe(asks);
    expect(state.run).toBe(run);
    expect(state.live).toEqual({
      runId: 'run-1',
      progress: writing('Hello', '2026-11-07T10:00:06.000Z'),
    });
  });

  it('keeps progress out of the run, and live only while the run works', () => {
    const store = createConversationStore();
    store.getState().runRead(turn('run-1', 'running', writing('Draft')));

    expect(store.getState().run).not.toHaveProperty('progress');
    expect(store.getState().live?.progress.text).toBe('Draft');

    store.getState().runRead(turn('run-1', 'completed', writing('Draft')));

    expect(store.getState().live).toBeUndefined();
  });

  it('a read older than the stream does not step the live text back', () => {
    const store = createConversationStore();
    store.getState().progress('run-1', writing('Hello there', '2026-11-07T10:00:09.000Z'));

    store.getState().runRead(turn('run-1', 'running', writing('Hel', '2026-11-07T10:00:05.000Z')));

    expect(store.getState().live?.progress.text).toBe('Hello there');
  });

  it('starts over on a fresh read', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1'), said('2')], false);
    store.getState().markEnded(['run-1'], ['call-1']);
    store.getState().patch({ atBeginning: true, earlier: 'failed' });

    store.getState().pageRead([said('8'), said('9')], true);

    const state = store.getState();
    expect(state.messages.map((item) => item.id)).toEqual(['8', '9']);
    expect(state.ended.runs.size).toBe(0);
    expect(state.ended.calls.size).toBe(0);
    expect(state.atBeginning).toBe(false);
    expect(state.earlier).toBe('idle');
  });

  it('joins a read that meets what is known', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('1'), said('2'), said('3')], false);

    store.getState().pageRead([said('2'), said('3'), said('4')], false);

    expect(store.getState().messages.map((item) => item.id)).toEqual(['1', '2', '3', '4']);
  });

  it('marks the beginning when an earlier page is short', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('10'), said('11')], false);

    store.getState().earlierRead([said('8'), said('9')]);

    const state = store.getState();
    expect(state.messages.map((item) => item.id)).toEqual(['8', '9', '10', '11']);
    expect(state.atBeginning).toBe(true);
  });

  it('marks the beginning when an earlier page brings nothing new', () => {
    const store = createConversationStore();
    const page = Array.from({ length: MESSAGES_FIRST_PAGE }, (_, index) => said(`${index}`));
    store.getState().pageRead(page, false);

    store.getState().earlierRead(page);

    expect(store.getState().messages).toHaveLength(MESSAGES_FIRST_PAGE);
    expect(store.getState().atBeginning).toBe(true);
  });

  it('keeps reading back while earlier pages are full', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('latest')], false);

    store
      .getState()
      .earlierRead(Array.from({ length: MESSAGES_FIRST_PAGE }, (_, index) => said(`old-${index}`)));

    expect(store.getState().atBeginning).toBe(false);
  });

  it('keeps only the latest page in the snapshot', () => {
    const store = createConversationStore();
    const older = Array.from({ length: 5 }, (_, index) =>
      said(`old-${index}`, { runId: `old-run-${index}` }),
    );
    const latest = Array.from({ length: MESSAGES_FIRST_PAGE }, (_, index) =>
      said(`new-${index}`, { runId: 'new-run' }),
    );
    store.getState().pageRead(latest, false);
    store.getState().earlierRead(older);
    store.getState().turnsRead(
      ['old-run-0', 'new-run'],
      [
        ['old-run-0', [step('old')]],
        ['new-run', [step('new')]],
      ],
      [['old-run-0', { question: { prompt: 'Which one?' } as never }]],
    );
    store.getState().runRead(turn('new-run', 'running', writing('Draft')));

    const kept = store.getState().snapshot();

    expect(kept.messages.map((item) => item.id)).toEqual(latest.map((item) => item.id));
    expect(kept.tools.map(([runId]) => runId)).toEqual(['new-run']);
    expect(kept.asks).toEqual([]);
    expect(kept.run?.id).toBe('new-run');
  });

  it('opens from a kept snapshot without loading', () => {
    const store = createConversationStore({
      messages: [said('1', { runId: 'run-1' })],
      tools: [['run-1', [step('a')]]],
      asks: [],
      callTools: [],
      subagents: [],
      people: [{ id: 'person-1', name: 'Mara Quill' } as never],
      run: turn('run-1', 'completed'),
    });

    const state = store.getState();
    expect(state.loading).toBe(false);
    expect(state.messages.map((item) => item.id)).toEqual(['1']);
    expect(state.tools.get('run-1')).toHaveLength(1);
    expect(state.people.get('person-1')?.name).toBe('Mara Quill');
    expect(state.run?.id).toBe('run-1');
    expect(createConversationStore().getState().loading).toBe(true);
  });

  it('keeps the agents a poll found unchanged, and the list when none changed', () => {
    const store = createConversationStore();
    const agent = (runId: string, status: Subagent['status']): Subagent =>
      ({
        runId,
        parentRunId: 'run-1',
        sessionId: `${runId}-session`,
        name: 'Scout',
        role: 'execute',
        status,
        input: 'Look.',
        createdAt: '2026-11-07T10:00:00.000Z',
        updatedAt: '2026-11-07T10:00:00.000Z',
      }) as Subagent;
    store.getState().subagentsRead([agent('a', 'running'), agent('b', 'running')]);
    const first = store.getState().subagents;

    store.getState().subagentsRead([agent('a', 'running'), agent('b', 'running')]);
    expect(store.getState().subagents).toBe(first);

    store.getState().subagentsRead([agent('a', 'running'), agent('b', 'completed')]);
    const [a, b] = store.getState().subagents;
    expect(a).toBe(first[0]);
    expect(b?.status).toBe('completed');
  });

  it('replaces one message a reaction changed, and keeps every other as it was', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('a'), answer('b', 'run-1')], false);
    const [first] = store.getState().messages;

    store
      .getState()
      .messageChanged({ ...answer('b', 'run-1'), reactions: [{ actor: 'owner', emoji: '🎉' }] });

    const [kept, changed] = store.getState().messages;
    expect(kept).toBe(first);
    expect(changed?.reactions).toEqual([{ actor: 'owner', emoji: '🎉' }]);
  });

  it('leaves the conversation alone when the changed message is not in it', () => {
    const store = createConversationStore();
    store.getState().pageRead([said('a')], false);
    const before = store.getState().messages;

    store.getState().messageChanged(said('gone'));

    expect(store.getState().messages).toBe(before);
  });
});

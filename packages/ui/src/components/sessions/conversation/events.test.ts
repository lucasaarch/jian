import { STREAM_OPENED_EVENT } from '@jian/contracts';
import { onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Run, Subagent } from '../../../lib/api';

let hear:
  | ((event: { id: number; type: string; data?: unknown; runId?: string }) => void)
  | undefined;
vi.mock('../../../lib/events', () => ({
  subscribe: (listener: typeof hear) => {
    hear = listener;
    return () => {
      hear = undefined;
    };
  },
}));
vi.mock('../inspector-host', () => ({ focusInspector: vi.fn() }));

import { focusInspector } from '../inspector-host';
import { followConversation } from './events';
import { createReader, type HistoryApi } from './reader';
import { createConversationStore } from './store';

/** The stream names conversations and turns by UUID, and drops a frame that does not. */
const SESSION = '00000000-0000-4000-8000-00000000005e';
const RUN = '00000000-0000-4000-8000-000000000001';

const turn = (id: string, status: Run['status'] = 'running'): Run =>
  ({
    id,
    profileId: 'profile',
    sessionId: SESSION,
    status,
    createdAt: '2026-11-07T10:00:00.000Z',
    updatedAt: '2026-11-07T10:00:00.000Z',
  }) as Run;

const said = (id: string, runId: string): Message => ({
  id,
  profileId: 'profile',
  sessionId: SESSION,
  role: 'user',
  runId,
  content: `Line ${id}`,
  createdAt: '2026-11-07T10:00:00.000Z',
});

const writing = (text: string) => ({
  phase: 'writing' as const,
  text,
  steps: 0,
  updatedAt: '2026-11-07T10:00:05.000Z',
});

/** Counts each kind of read, answering as `state` says the gateway is now. */
function counted(state: { run: Run; subagents?: Subagent[] }) {
  const reads = { messages: 0, activities: 0, run: 0, subagents: 0, timeline: [] as string[][] };
  const api: HistoryApi = {
    messages: async () => {
      reads.messages += 1;
      return [said('asked', state.run.id)];
    },
    activities: async () => {
      reads.activities += 1;
      return [state.run];
    },
    timeline: async (_profile, _session, runs = []) => {
      reads.timeline.push(runs);
      return runs.map((runId) => ({ runId, steps: [] }));
    },
    run: async () => {
      reads.run += 1;
      return { ...state.run, progress: writing('From the run') } as Run;
    },
    conversationSubagents: async () => {
      reads.subagents += 1;
      return state.subagents ?? [];
    },
  } as HistoryApi;
  return { api, reads };
}

/** A conversation open on a turn at work, read once, and following the stream. */
async function following(state: { run: Run; subagents?: Subagent[] }) {
  const { api, reads } = counted(state);
  const store = createConversationStore();
  const reader = createReader({
    api,
    profileId: 'profile',
    sessionId: SESSION,
    group: false,
    store,
    reloads: () => 0,
  });
  await reader.latest();
  const unfollow = followConversation({ store, reader, sessionId: SESSION });
  const counts = () => ({ ...reads, timeline: [...reads.timeline] });
  return { store, reader, reads, unfollow, before: counts() };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  hear = undefined;
});

describe('following a conversation', () => {
  it('a progress event with text updates without reading', async () => {
    const { store, reads, before, unfollow } = await following({ run: turn(RUN) });

    hear?.({
      id: 0,
      type: 'run.progress',
      data: { runId: RUN, sessionId: SESSION, at: 'now', progress: writing('Hello') },
    });
    expect(store.getState().live?.progress.text).toBe('Hello');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reads.messages).toBe(before.messages);
    expect(reads.timeline).toEqual(before.timeline);
    expect(reads.run).toBe(0);
    unfollow();
  });

  it('a progress event of another conversation is not this one’s', async () => {
    const { store, unfollow } = await following({ run: turn(RUN) });

    hear?.({
      id: 0,
      type: 'run.progress',
      data: {
        runId: '00000000-0000-4000-8000-000000000009',
        sessionId: '00000000-0000-4000-8000-0000000000e1',
        at: 'now',
        progress: writing('Hello'),
      },
    });

    expect(store.getState().live).toBeUndefined();
    unfollow();
  });

  it('a progress event without text reads only that run', async () => {
    const { store, reads, before, unfollow } = await following({ run: turn(RUN) });

    hear?.({ id: 0, type: 'run.progress', data: { runId: RUN, sessionId: SESSION, at: 'now' } });
    await vi.advanceTimersByTimeAsync(200);

    expect(reads.run).toBe(1);
    expect(reads.messages).toBe(before.messages);
    expect(reads.timeline).toEqual(before.timeline);
    expect(store.getState().live?.progress.text).toBe('From the run');
    unfollow();
  });

  it('a step reads only the live turn’s tools', async () => {
    const { reads, before, unfollow } = await following({ run: turn(RUN) });

    for (let heard = 0; heard < 3; heard++) hear?.({ id: heard, type: 'run.step', runId: RUN });
    await vi.advanceTimersByTimeAsync(200);

    expect(reads.timeline).toEqual([...before.timeline, [RUN]]);
    expect(reads.messages).toBe(before.messages);
    unfollow();
  });

  it('a step of a turn that is not this conversation’s reads nothing', async () => {
    const { reads, before, unfollow } = await following({ run: turn(RUN) });

    hear?.({ id: 0, type: 'run.step', runId: 'run-elsewhere' });
    await vi.advanceTimersByTimeAsync(200);

    expect(reads).toEqual(before);
    unfollow();
  });

  it('an ended turn is read once more, then never', async () => {
    const state = { run: turn(RUN) };
    const { reads, before, unfollow } = await following(state);

    state.run = turn(RUN, 'completed');
    hear?.({ id: 1, type: 'run.completed', runId: RUN });
    await vi.advanceTimersByTimeAsync(200);
    expect(reads.messages).toBe(before.messages + 1);
    expect(reads.timeline).toEqual([...before.timeline, [RUN]]);

    hear?.({ id: 2, type: 'run.step', runId: RUN });
    hear?.({ id: 3, type: 'session.updated', data: { sessionId: SESSION } });
    await vi.advanceTimersByTimeAsync(200);
    expect(reads.messages).toBe(before.messages + 2);
    expect(reads.timeline).toEqual([...before.timeline, [RUN]]);
    unfollow();
  });

  it('reads one at a time, and once more for what was heard meanwhile', async () => {
    const state = { run: turn(RUN, 'completed') };
    const { api } = counted(state);
    let open = 0;
    let most = 0;
    let reads = 0;
    let release: (() => void) | undefined;
    api.messages = async () => {
      reads += 1;
      open += 1;
      most = Math.max(most, open);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      open -= 1;
      return [];
    };
    const store = createConversationStore();
    const reader = createReader({
      api,
      profileId: 'profile',
      sessionId: SESSION,
      group: false,
      store,
      reloads: () => 0,
    });
    const unfollow = followConversation({ store, reader, sessionId: SESSION });

    void reader.latest();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    for (let heard = 0; heard < 3; heard++) {
      hear?.({ id: heard, type: 'session.updated', data: { sessionId: SESSION } });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(reads).toBe(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(2);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(2);
    expect(most).toBe(1);
    unfollow();
  });

  it('reads a turn at work again when the stream falls silent', async () => {
    const { reads, before, unfollow } = await following({ run: turn(RUN) });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads.messages).toBe(before.messages);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reads.messages).toBe(before.messages + 1);
    // The wait doubles while the silence lasts: the next is 8 s after the first, at 12 s.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads.messages).toBe(before.messages + 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads.messages).toBe(before.messages + 2);
    unfollow();
  });

  it('a stream that speaks keeps the silent read away', async () => {
    const { reads, before, unfollow } = await following({ run: turn(RUN) });

    for (let second = 0; second < 10; second++) {
      hear?.({
        id: 0,
        type: 'run.progress',
        data: { runId: RUN, sessionId: SESSION, at: 'now', progress: writing(`${second}`) },
      });
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(reads.messages).toBe(before.messages);
    unfollow();
  });

  it('a conversation at rest is not read on a timer', async () => {
    const { reads, before, unfollow } = await following({ run: turn(RUN, 'completed') });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(reads).toEqual(before);
    unfollow();
  });

  it('follows its subagents while one runs', async () => {
    const child = { runId: 'child-1', status: 'running' } as Subagent;
    const state = { run: turn(RUN, 'completed'), subagents: [child] };
    const { reads, before, unfollow } = await following(state);

    await vi.advanceTimersByTimeAsync(1_600);
    expect(reads.subagents).toBe(before.subagents + 1);
    state.subagents = [{ ...child, status: 'completed' } as Subagent];
    await vi.advanceTimersByTimeAsync(1_500);
    const ended = reads.subagents;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(reads.subagents).toBe(ended);
    expect(reads.messages).toBe(before.messages);
    unfollow();
  });

  it('a subagent’s events read the subagents', async () => {
    const { reads, before, unfollow } = await following({ run: turn(RUN, 'completed') });

    hear?.({
      id: 0,
      type: 'conversation.subagent.spawned',
      data: { parentSessionId: SESSION },
      runId: 'child-1',
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(reads.subagents).toBe(before.subagents + 1);
    expect(reads.messages).toBe(before.messages);
    unfollow();
  });

  it('reads the conversation when the stream opens and when the gateway is back', async () => {
    const { reads, before, unfollow } = await following({ run: turn(RUN, 'completed') });

    hear?.({ id: 0, type: STREAM_OPENED_EVENT });
    await vi.advanceTimersByTimeAsync(200);
    expect(reads.messages).toBe(before.messages + 1);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(reads.messages).toBe(before.messages + 2);
    unfollow();
  });

  it('focuses the inspector when asked', async () => {
    const { unfollow } = await following({ run: turn(RUN, 'completed') });
    const request = { sessionId: SESSION, kind: 'browser' };

    hear?.({ id: 0, type: 'conversation.inspector.focus', data: request });

    expect(focusInspector).toHaveBeenCalledWith(SESSION, request);
    unfollow();
  });

  it('hears nothing once unfollowed', async () => {
    const { reads, before, unfollow } = await following({ run: turn(RUN) });

    unfollow();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(hear).toBeUndefined();
    expect(reads).toEqual(before);
  });
});

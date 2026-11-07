import { MESSAGES_FIRST_PAGE } from '@jian/contracts';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message, Run, ToolStep } from '../../../lib/api';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { createReader, type HistoryApi } from './reader';
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

const turn = (id: string, status: Run['status'] = 'running'): Run =>
  ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    status,
    createdAt: '2026-11-07T10:00:00.000Z',
    updatedAt: '2026-11-07T10:00:00.000Z',
  }) as Run;

const step = (toolCallId: string): ToolStep =>
  ({
    toolCallId,
    toolName: 'read_file',
    status: 'done',
    startedAt: '2026-11-07T10:00:01.000Z',
  }) as ToolStep;

/** A gateway that answers at once, and keeps what each read asked for. */
function fakeApi(over: Partial<HistoryApi> = {}) {
  const asked = {
    messages: [] as { before?: string; limit?: number }[],
    timeline: [] as { profileId: string; sessionId: string; runs?: string[] }[],
  };
  const api: HistoryApi = {
    messages: async (_profile, _session, page = {}) => {
      asked.messages.push(page);
      return [];
    },
    activities: async () => [],
    timeline: async (profileId, sessionId, runs) => {
      asked.timeline.push({ profileId, sessionId, runs });
      return (runs ?? []).map((runId) => ({ runId, steps: [step(`${runId}-tool`)] }));
    },
    ...over,
  } as HistoryApi;
  return { api, asked };
}

/** A timeline whose first read is held until released, answering `stale`; later ones `later`. */
function slowFirst(later: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const timeline: HistoryApi['timeline'] = async (_profile, _session, runs = []) => {
    reads += 1;
    const first = reads === 1;
    if (first) await held;
    return runs.map((runId) => ({ runId, steps: [step(first ? 'stale' : later)] }));
  };
  return { timeline, release };
}

const open = (api: HistoryApi, options: { reloads?: () => number; group?: boolean } = {}) => {
  const store = createConversationStore();
  const reader = createReader({
    api,
    profileId: 'profile',
    sessionId: 'session',
    group: options.group ?? false,
    store,
    reloads: options.reloads ?? (() => 0),
  });
  return { store, reader };
};

afterEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('the conversation reader', () => {
  it('asks for 40 messages', async () => {
    const { api, asked } = fakeApi();
    const { reader } = open(api);

    await reader.latest();

    expect(asked.messages).toEqual([{ limit: MESSAGES_FIRST_PAGE }]);
    expect(MESSAGES_FIRST_PAGE).toBe(40);
  });

  it('reads one at a time, and once more for what was asked meanwhile', async () => {
    let open_ = 0;
    let most = 0;
    let reads = 0;
    let release: (() => void) | undefined;
    const { api } = fakeApi({
      messages: async () => {
        reads += 1;
        open_ += 1;
        most = Math.max(most, open_);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        open_ -= 1;
        return [];
      },
    });
    const { reader } = open(api);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    const first = reader.latest();
    void reader.latest();
    void reader.latest();
    await settle();
    expect(reads).toBe(1);
    release?.();
    await settle();
    expect(reads).toBe(2);
    release?.();
    await first;
    expect(reads).toBe(2);
    expect(most).toBe(1);
  });

  it('reads the page before the turn, so the answer takes the live row', async () => {
    const order: string[] = [];
    const { api } = fakeApi({
      messages: async () => {
        order.push('messages');
        return [said('asked', { runId: 'run-1' })];
      },
      activities: async () => {
        order.push('activities');
        return [turn('run-1', 'completed')];
      },
    });
    const { store, reader } = open(api);
    const calls: string[] = [];
    store.subscribe((state, previous) => {
      if (state.messages !== previous.messages) calls.push('page');
      if (state.run !== previous.run) calls.push('run');
    });

    await reader.latest();

    expect(calls.indexOf('page')).toBeLessThan(calls.indexOf('run'));
  });

  it('reads the tools of the page’s turns that have not ended', async () => {
    const { api, asked } = fakeApi({
      messages: async () => [
        said('old', { runId: 'run-old', createdAt: '2026-11-07T09:00:00.000Z' }),
        said('new', { runId: 'run-new' }),
      ],
      activities: async () => [turn('run-old', 'completed'), turn('run-new')],
    });
    const { store, reader } = open(api);

    await reader.latest();
    await reader.latest();

    expect(asked.timeline.map((read) => read.runs)).toEqual([['run-old', 'run-new'], ['run-new']]);
    expect(store.getState().tools.get('run-new')?.[0]?.toolCallId).toBe('run-new-tool');
  });

  it('an ended turn is read once more, then never', async () => {
    let status: Run['status'] = 'running';
    const { api, asked } = fakeApi({
      messages: async () => [said('asked', { runId: 'run-1' })],
      activities: async () => [turn('run-1', status)],
    });
    const { reader } = open(api);

    await reader.latest();
    await reader.turns(['run-1']);
    status = 'completed';
    await reader.latest();
    await reader.latest();
    await reader.turns(['run-1']);

    expect(asked.timeline.map((read) => read.runs)).toEqual([['run-1'], ['run-1'], ['run-1']]);
  });

  it('asks for brief tools on every read it makes, its own turns and the other agent’s', async () => {
    const briefs: (boolean | undefined)[] = [];
    const call = { profileId: 'other', sessionId: 'there', runId: 'call-1' };
    const { api } = fakeApi({
      messages: async (_profile, _session, page = {}) =>
        page.before
          ? [said('m0', { runId: 'run-0' })]
          : [
              said('m1', { runId: 'run-1' }),
              said('m2', { role: 'assistant', call } as Partial<Message>),
            ],
      activities: async () => [turn('run-1')],
      run: async (_profile, runId) => turn(runId),
      timeline: async (_profile, _session, runs = [], options) => {
        briefs.push(options?.brief);
        return runs.map((runId) => ({ runId, steps: [step(`${runId}-tool`)] }));
      },
    });
    const { reader } = open(api);

    await reader.latest();
    await reader.turns(['run-1']);
    await reader.call();
    await reader.earlier();

    // latest: its turns and the call; turns; the call; earlier.
    expect(briefs).toEqual([true, true, true, true, true]);
  });

  it('never asks the timeline for no turn', async () => {
    const { api, asked } = fakeApi();
    const { reader } = open(api);

    await reader.latest();
    await reader.turns([]);

    expect(asked.timeline).toEqual([]);
  });

  it('reads the other agent’s turn where it worked', async () => {
    const call = { profileId: 'other', sessionId: 'there', runId: 'call-1' };
    const { api, asked } = fakeApi({
      messages: async () => [said('carried', { role: 'assistant', call } as Partial<Message>)],
    });
    const { store, reader } = open(api);

    await reader.latest();

    expect(asked.timeline).toEqual([{ profileId: 'other', sessionId: 'there', runs: ['call-1'] }]);
    expect(store.getState().callTools.get('call-1')).toHaveLength(1);
  });

  it('starts over when a reload was asked for, and says so', async () => {
    let reloads = 0;
    let page = [said('a'), said('b')];
    const { api } = fakeApi({ messages: async () => page });
    const { store, reader } = open(api, { reloads: () => reloads });

    await reader.latest();
    page = [said('c')];
    reloads = 1;
    await reader.latest();

    expect(store.getState().messages.map((message) => message.id)).toEqual(['c']);
    expect(toast.success).toHaveBeenCalledWith('Chat reloaded.');
  });

  it('a failed first read is an error; a later one leaves what is shown behind', async () => {
    let fail = true;
    const { api } = fakeApi({
      messages: async () => {
        if (fail) throw new Error('Gateway unreachable');
        return [said('a')];
      },
    });
    const { store, reader } = open(api);

    await reader.latest();
    expect(store.getState()).toMatchObject({ loading: false, error: 'Gateway unreachable' });
    fail = false;
    await reader.latest();
    expect(store.getState()).toMatchObject({ error: '', behind: false });
    fail = true;
    await reader.latest();
    expect(store.getState()).toMatchObject({ error: '', behind: true });
    expect(store.getState().messages).toHaveLength(1);
  });

  it('a reload that fails while something is shown says so', async () => {
    let reloads = 0;
    let fail = false;
    const { api } = fakeApi({
      messages: async () => {
        if (fail) throw new Error('Gateway unreachable');
        return [said('a')];
      },
    });
    const { reader } = open(api, { reloads: () => reloads });

    await reader.latest();
    fail = true;
    reloads = 1;
    await reader.latest();
    await reader.latest();

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      'This chat could not be reloaded: Gateway unreachable',
    );
  });

  it('forgets awaited turns sent before the read began', async () => {
    const { api } = fakeApi();
    const { store, reader } = open(api);
    store.getState().patch({
      awaited: new Map([
        ['old', '2000-01-01T00:00:00.000Z'],
        ['new', '2999-01-01T00:00:00.000Z'],
      ]),
    });

    await reader.latest();

    expect([...store.getState().awaited.keys()]).toEqual(['new']);
  });

  it('never reads two earlier pages at once', async () => {
    const before: (string | undefined)[] = [];
    let release: (() => void) | undefined;
    const { api } = fakeApi({
      messages: async (_profile, _session, page = {}) => {
        if (!page.before) return [said('m40')];
        before.push(page.before);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [said('m39')];
      },
    });
    const { store, reader } = open(api);
    await reader.latest();

    const first = reader.earlier();
    void reader.earlier();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().earlier).toBe('reading');
    release?.();
    await first;

    expect(before).toEqual(['m40']);
    expect(store.getState().messages.map((message) => message.id)).toEqual(['m39', 'm40']);
    expect(store.getState().atBeginning).toBe(true);
  });

  it('reads 40 earlier messages with their tools', async () => {
    const pages: { before?: string; limit?: number }[] = [];
    const { api, asked } = fakeApi({
      messages: async (_profile, _session, page = {}) => {
        pages.push(page);
        return page.before ? [said('m1', { runId: 'run-0' })] : [said('m2')];
      },
    });
    const { store, reader } = open(api);

    await reader.latest();
    await reader.earlier();

    expect(pages[1]).toEqual({ before: 'm2', limit: MESSAGES_FIRST_PAGE });
    expect(asked.timeline.map((read) => read.runs)).toEqual([['run-0']]);
    expect(store.getState().tools.has('run-0')).toBe(true);
  });

  it('a failed earlier read can be tried again', async () => {
    const { api } = fakeApi({
      messages: async (_profile, _session, page = {}) => {
        if (page.before) throw new Error('Gateway unreachable');
        return [said('m2')];
      },
    });
    const { store, reader } = open(api);

    await reader.latest();
    await reader.earlier();

    expect(store.getState().earlier).toBe('failed');
  });

  it('reads a run and tells its progress', async () => {
    const progress = {
      phase: 'writing' as const,
      text: 'Halfway',
      steps: 0,
      updatedAt: '2026-11-07T10:00:05.000Z',
    };
    const { api, asked } = fakeApi({
      activities: async () => [turn('run-1')],
      run: async () => ({ ...turn('run-1'), progress }) as Run,
    });
    const { store, reader } = open(api);
    await reader.latest();

    await reader.run('run-1');

    expect(store.getState().live).toEqual({ runId: 'run-1', progress });
    expect(asked.messages).toHaveLength(1);
  });

  it('a run read whose text stopped going on reads the page for the paragraph it released', async () => {
    let text = 'First paragraph.';
    let second = 5;
    const { api, asked } = fakeApi({
      activities: async () => [turn('run-1')],
      run: async () =>
        ({
          ...turn('run-1'),
          progress: {
            phase: 'writing',
            text,
            steps: 0,
            updatedAt: `2026-11-07T10:00:0${second}.000Z`,
          },
        }) as Run,
    });
    const { reader } = open(api);
    await reader.latest();

    await reader.run('run-1');
    expect(asked.messages).toHaveLength(1);

    // A gateway older than progress text in the stream: only a read of the run tells the text.
    text = 'Second';
    second = 6;
    await reader.run('run-1');

    expect(asked.messages).toHaveLength(2);
  });

  it('a run read after it ended reads the page first', async () => {
    let status: Run['status'] = 'running';
    const { api, asked } = fakeApi({
      activities: async () => [turn('run-1', status)],
      run: async () => turn('run-1', status),
    });
    const { store, reader } = open(api);
    await reader.latest();
    status = 'completed';

    await reader.run('run-1');

    expect(asked.messages).toHaveLength(2);
    expect(store.getState().run?.status).toBe('completed');
  });

  it('a slow step read never overwrites a turn that ended meanwhile', async () => {
    const { timeline, release } = slowFirst('final');
    const { api } = fakeApi({
      messages: async () => [said('asked', { runId: 'run-1' })],
      activities: async () => [turn('run-1', 'completed')],
      timeline,
    });
    const { store, reader } = open(api);

    const slow = reader.turns(['run-1']);
    await reader.latest();
    expect(store.getState().ended.runs.has('run-1')).toBe(true);
    release();
    await slow;

    expect(
      store
        .getState()
        .tools.get('run-1')
        ?.map((item) => item.toolCallId),
    ).toEqual(['final']);
  });

  it('a slow read of the other agent never overwrites its turn once the answer is back', async () => {
    const call = { profileId: 'other', sessionId: 'there', runId: 'call-1' };
    const carried = said('carried', { role: 'assistant', call } as Partial<Message>);
    let page = [carried];
    const { timeline, release } = slowFirst('final');
    const { api } = fakeApi({
      messages: async () => page,
      run: async () => turn('call-1'),
      timeline,
    });
    const { store, reader } = open(api);
    store.getState().pageRead(page, false);

    const slow = reader.call();
    page = [carried, said('back', { call } as Partial<Message>)];
    await reader.latest();
    expect(store.getState().ended.calls.has('call-1')).toBe(true);
    release();
    await slow;

    expect(
      store
        .getState()
        .callTools.get('call-1')
        ?.map((item) => item.toolCallId),
    ).toEqual(['final']);
    expect(store.getState().callRun).toBeUndefined();
  });

  it('an older read of a running turn never lands over a newer one', async () => {
    const { timeline, release } = slowFirst('newer');
    const { api } = fakeApi({
      messages: async () => [said('asked', { runId: 'run-1' })],
      activities: async () => [turn('run-1')],
      timeline,
    });
    const { store, reader } = open(api);

    const slow = reader.turns(['run-1']);
    await reader.latest();
    release();
    await slow;

    expect(
      store
        .getState()
        .tools.get('run-1')
        ?.map((item) => item.toolCallId),
    ).toEqual(['newer']);
    expect(store.getState().ended.runs.has('run-1')).toBe(false);
  });

  it('a stopped reader writes nothing', async () => {
    let release: (() => void) | undefined;
    const { api } = fakeApi({
      messages: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [said('late')];
      },
      activities: async () => [turn('run-1')],
      conversationSubagents: async () => [],
    });
    const { store, reader } = open(api);
    const before = store.getState();

    const read = reader.latest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    reader.stop();
    release?.();
    await read;
    await reader.turns(['run-1']);
    await reader.subagents();
    await reader.earlier();

    expect(store.getState()).toBe(before);
  });
});

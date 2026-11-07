import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { expect, it, vi } from 'vitest';
import type { GatewayApi, Run } from '../../lib/api';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../lib/query/client';
import { sendNow, useOutbox } from '../../lib/stores/outbox';
import { useReconnect } from '../../lib/stores/reconnect';
import { CrewDrawer } from './crew-drawer';
import { History } from './history';

/** The trace is built only while open, so a test that reads its lines opens them first. */
const openTraces = (root: ParentNode) =>
  act(() => {
    for (const head of root.querySelectorAll<HTMLButtonElement>(
      '.thought-head[aria-expanded="false"]',
    ))
      head.click();
  });

/** A tool's body is built when its details open; the test DOM does not fire `toggle` itself. */
const openTools = (root: ParentNode) =>
  act(() => {
    for (const details of root.querySelectorAll<HTMLDetailsElement>('details.thought-tool')) {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    }
  });

let hear: ((event: { type: string; data?: unknown }) => void) | undefined;
vi.mock('../../lib/events', () => ({
  subscribe: (listener: () => void) => {
    hear = listener;
    return () => {
      hear = undefined;
    };
  },
}));

/** Reduced motion shows streamed text whole, so a test reads it without waiting on frames. */
const stillMotion = () =>
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

const mount = async (view: ReactNode) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(view));
  return {
    element,
    show: (next: ReactNode) => act(async () => root.render(next)),
    done: async () => {
      await act(async () => root.unmount());
      element.remove();
      useOutbox.setState({ items: [] });
      vi.unstubAllGlobals();
    },
  };
};

it('a sent message keeps its element when it lands', async () => {
  let stored = false;
  const hello = {
    id: 'hello',
    profileId: 'profile',
    sessionId: 'session',
    runId: 'hello-run',
    role: 'user' as const,
    content: 'Hello there',
    createdAt: '2026-11-07T10:00:00Z',
  };
  const api = {
    messages: async () => (stored ? [hello] : []),
    activities: async () => [],
    timeline: async () => [],
  };
  const view = await mount(<History api={api} profileId="profile" sessionId="session" />);

  try {
    await act(async () =>
      sendNow({
        sessionId: 'session',
        text: 'Hello there',
        mediaIds: [],
        deliver: async () => ({ id: 'hello-run' }),
        delivered: () => {},
      }),
    );
    const sent = view.element.querySelector('.chat-line.mine');
    expect(sent?.textContent).toContain('Hello there');

    stored = true;
    await view.show(<History api={api} profileId="profile" sessionId="session" revision={1} />);

    expect(sent?.isConnected).toBe(true);
    expect(sent?.getAttribute('data-message-id')).toBe('hello');
    expect(view.element.querySelectorAll('.chat-line.mine')).toHaveLength(1);
  } finally {
    await view.done();
  }
});

it('the answer keeps its element when the turn ends', async () => {
  stillMotion();
  let ended = false;
  const at = '2026-11-07T10:00:00Z';
  const turn = (): Run =>
    ({
      id: 'answer-run',
      profileId: 'profile',
      sessionId: 'session',
      status: ended ? 'completed' : 'running',
      createdAt: at,
      updatedAt: at,
      ...(ended
        ? {}
        : {
            progress: {
              phase: 'writing',
              text: 'The build passed',
              steps: 0,
              updatedAt: '2026-11-07T10:00:02Z',
            },
          }),
    }) as Run;
  const said = (id: string, role: 'user' | 'assistant', content: string) => ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    runId: 'answer-run',
    role,
    content,
    createdAt: at,
  });
  const api = {
    messages: async () => [
      said('request', 'user', 'Run the build'),
      ...(ended ? [said('answer', 'assistant', 'The build passed and the tests are green.')] : []),
    ],
    activities: async () => [turn()],
    timeline: async () => [],
  };
  const answer = (root: ParentNode, words: string) =>
    [...root.querySelectorAll('article')].find((item) => item.textContent?.includes(words));
  const view = await mount(
    <History api={api} profileId="profile" sessionId="session" initialRun={turn()} />,
  );

  try {
    const live = answer(view.element, 'The build passed');
    expect(live?.querySelector('.streaming')).not.toBeNull();

    ended = true;
    await view.show(
      <History
        api={api}
        profileId="profile"
        sessionId="session"
        initialRun={turn()}
        revision={1}
      />,
    );

    expect(answer(view.element, 'the tests are green')).toBe(live);
    expect(live?.isConnected).toBe(true);
    expect(view.element.querySelectorAll('.chat-line.theirs')).toHaveLength(1);
    expect(view.element.querySelector('.pending')).toBeNull();
  } finally {
    await view.done();
  }
});

it('a progress event shows new text without reading the conversation', async () => {
  stillMotion();
  vi.useFakeTimers();
  const runId = '0b9f3c1e-5d1a-4f7e-9a51-1c2d3e4f5a6b';
  const sessionId = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
  const working = {
    id: runId,
    profileId: 'profile',
    sessionId,
    status: 'running',
    createdAt: '2026-11-07T10:00:00Z',
    updatedAt: '2026-11-07T10:00:00Z',
  } as Run;
  let reads = 0;
  const api = {
    messages: async () => {
      reads += 1;
      return [];
    },
    activities: async () => [working],
    timeline: async () => [],
  };
  const view = await mount(
    <History api={api} profileId="profile" sessionId={sessionId} initialRun={working} />,
  );

  try {
    const before = reads;
    await act(async () => {
      hear?.({
        type: 'run.progress',
        data: {
          runId,
          sessionId,
          at: '2026-11-07T10:00:03Z',
          progress: {
            phase: 'writing',
            text: 'Halfway through the report.',
            steps: 0,
            updatedAt: '2026-11-07T10:00:03.000Z',
          },
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(view.element.querySelector('.streaming')?.textContent).toBe(
      'Halfway through the report.',
    );
    expect(reads).toBe(before);
  } finally {
    await view.done();
    vi.useRealTimers();
  }
});

it('opens with the latest 40 and reads 40 more near the top', async () => {
  const all = Array.from({ length: 100 }, (_, number) => ({
    id: `m${number}`,
    profileId: 'profile',
    sessionId: 'session',
    runId: `run-${number}`,
    role: 'assistant' as const,
    content: `Said m${number}.`,
    createdAt: new Date(Date.UTC(2026, 10, 7, 10, 0, 0, number)).toISOString(),
  }));
  const messages = vi.fn(
    async (_profile: string, _session: string, at?: { before?: string; limit?: number }) => {
      const end = at?.before ? all.findIndex((item) => item.id === at.before) : all.length;
      return all.slice(Math.max(0, end - (at?.limit ?? 100)), end);
    },
  );
  const api = { messages, activities: async () => [], timeline: async () => [] };
  const view = await mount(<History api={api} profileId="profile" sessionId="session" />);
  const said = () => view.element.querySelector('.message-list')?.textContent ?? '';

  try {
    expect(messages.mock.calls[0]?.[2]).toEqual({ limit: 40 });
    expect(said()).toContain('Said m60.');
    expect(said()).not.toContain('Said m59.');

    await act(async () => {
      view.element.querySelector('.message-history')?.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(messages.mock.calls.at(-1)?.[2]).toEqual({ before: 'm60', limit: 40 });
    expect(said()).toContain('Said m20.');
    expect(said()).not.toContain('Said m19.');
    expect(said().indexOf('Said m59.')).toBeLessThan(said().indexOf('Said m60.'));
  } finally {
    await view.done();
  }
});

/** Motion on, with frames on the fake clock, so a reveal can be watched step by step. */
const movingFrames = () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (run: (now: number) => void) =>
    setTimeout(() => run(performance.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
};

it('keeps the working line while the agent writes a tool after a released paragraph', async () => {
  stillMotion();
  const runId = '1d2e3f40-5a6b-4c7d-8e9f-a0b1c2d3e4f5';
  const sessionId = '2e3f4051-6b7c-4d8e-9fa0-b1c2d3e4f5a6';
  const at = '2026-11-07T10:00:00.000Z';
  const working = {
    id: runId,
    profileId: 'profile',
    sessionId,
    status: 'running',
    createdAt: at,
    updatedAt: at,
    progress: {
      phase: 'writing',
      text: 'First paragraph.',
      steps: 0,
      updatedAt: '2026-11-07T10:00:02.000Z',
    },
  } as Run;
  const said = (id: string, role: 'user' | 'assistant', content: string) => ({
    id,
    profileId: 'profile',
    sessionId,
    runId,
    role,
    content,
    createdAt: at,
  });
  const api = {
    messages: async () => [
      said('request', 'user', 'Write the report'),
      said('paragraph', 'assistant', 'First paragraph.'),
    ],
    activities: async () => [working],
    timeline: async () => [],
  };
  const view = await mount(
    <History api={api} profileId="profile" sessionId={sessionId} initialRun={working} />,
  );
  const workingLine = () => view.element.querySelector('.thought-line[data-working]');

  try {
    // The paragraph was just handed to the stored answer: nothing new to show under it yet.
    expect(workingLine()).toBeNull();

    // Released, the stream goes on writing a tool's input, with no text of its own.
    await act(async () =>
      hear?.({
        type: 'run.progress',
        data: {
          runId,
          sessionId,
          at: '2026-11-07T10:00:03.000Z',
          progress: { phase: 'writing', text: '', steps: 0, updatedAt: '2026-11-07T10:00:03.000Z' },
        },
      }),
    );

    expect(workingLine()).not.toBeNull();
    expect(view.element.querySelectorAll('.chat-text')).toHaveLength(2);
  } finally {
    await view.done();
  }
});

it('the answer never retypes when it lands after text that ended in a break', async () => {
  movingFrames();
  let stored = false;
  const at = '2026-11-07T10:00:00Z';
  const working = {
    id: 'break-run',
    profileId: 'profile',
    sessionId: 'session',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    progress: {
      phase: 'writing',
      text: 'Hello there.\n\n',
      steps: 0,
      updatedAt: '2026-11-07T10:00:02.000Z',
    },
  } as Run;
  const said = (id: string, role: 'user' | 'assistant', content: string) => ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    runId: 'break-run',
    role,
    content,
    createdAt: at,
  });
  const api = {
    messages: async () => [
      said('request', 'user', 'Say hello'),
      ...(stored ? [said('answer', 'assistant', 'Hello there.')] : []),
    ],
    activities: async () => [working],
    timeline: async () => [],
  };
  const view = await mount(
    <History api={api} profileId="profile" sessionId="session" initialRun={working} />,
  );
  const answer = () => view.element.querySelector('.chat-line.theirs');
  const lengths: number[] = [];
  const watch = async (ms: number) => {
    for (let waited = 0; waited < ms; waited += 16) {
      await act(async () => vi.advanceTimersByTimeAsync(16));
      lengths.push(answer()?.querySelector('.chat-text')?.textContent?.length ?? 0);
    }
  };

  try {
    await watch(80);
    const live = answer();
    expect(live?.textContent).toContain('Hel');
    await watch(600);

    stored = true;
    await view.show(
      <History
        api={api}
        profileId="profile"
        sessionId="session"
        initialRun={working}
        revision={1}
      />,
    );
    await watch(600);

    expect(lengths.every((length, at) => at === 0 || length >= (lengths[at - 1] ?? 0))).toBe(true);
    expect(answer()).toBe(live);
    expect(answer()?.querySelector('.chat-text')?.textContent).toBe('Hello there.');
  } finally {
    await view.done();
    vi.useRealTimers();
  }
});

it('animates nothing on open from a kept conversation, even when the first read brings newer lines', async () => {
  movingFrames();
  const line = (id: string, runId: string, role: 'user' | 'assistant', content: string) => ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    runId,
    role,
    content,
    createdAt: '2026-11-07T10:00:00Z',
  });
  const kept = [
    line('ask', 'run-1', 'user', 'Plan the trip'),
    line('one', 'run-1', 'assistant', 'One.'),
  ];
  let read = [
    ...kept,
    // A line that joined the kept answer while the owner was away, and a whole new turn.
    line('two', 'run-1', 'assistant', 'Two.'),
    line('again', 'run-2', 'user', 'And then?'),
    line('sure', 'run-2', 'assistant', 'Sure.'),
  ];
  const client = createQueryClient({ kept: true });
  client.setQueryData(['history', 'profile', 'session'], {
    messages: kept,
    tools: [],
    asks: [],
    callTools: [],
    subagents: [],
    people: [],
  });
  const api = { messages: async () => read, activities: async () => [], timeline: async () => [] };
  const page = (revision: number) => (
    <QueryClientProvider client={client}>
      <History api={api} profileId="profile" sessionId="session" revision={revision} />
    </QueryClientProvider>
  );
  const view = await mount(page(0));

  try {
    await act(async () => vi.advanceTimersByTimeAsync(16));
    const text = view.element.querySelector('.message-list')?.textContent ?? '';
    expect(text).toContain('Two.');
    expect(text).toContain('Sure.');
    expect(view.element.querySelector('[data-fresh]')).toBeNull();
    expect(view.element.querySelector('.streaming')).toBeNull();

    // Once open, what arrives is news, and enters.
    read = [...read, line('later', 'run-3', 'user', 'One more thing')];
    await view.show(page(1));
    expect(view.element.querySelector('[data-fresh]')?.textContent).toContain('One more thing');
  } finally {
    await view.done();
    vi.useRealTimers();
  }
});

it('outlines the conversation while it is loading', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let settle!: (messages: Awaited<ReturnType<GatewayApi['messages']>>) => void;
  const api = {
    messages: () =>
      new Promise<Awaited<ReturnType<GatewayApi['messages']>>>((resolve) => {
        settle = resolve;
      }),
    activities: async () => [],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" />),
    );
    const status = () => element.querySelector('[role="status"]')?.textContent;
    expect(status()).toBe('Loading conversation…');
    expect(element.querySelector('[aria-busy="true"] [role="status"]')).toBeNull();
    expect(element.textContent).not.toContain('Loading the history');
    await act(async () => settle([]));
    expect(status()).toBe('');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('shows messages before the timeline finishes loading', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let settleTimeline!: () => void;
  const api = {
    messages: async () => [
      {
        id: 'answer',
        profileId: 'profile',
        sessionId: 'session',
        runId: 'run',
        role: 'assistant' as const,
        content: 'The conversation is ready.',
        createdAt: '2026-10-31T10:00:00.000Z',
      },
    ],
    activities: async () => [],
    timeline: () =>
      new Promise<Awaited<ReturnType<GatewayApi['timeline']>>>((resolve) => {
        settleTimeline = () => resolve([]);
      }),
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" />),
    );
    expect(element.textContent).toContain('The conversation is ready.');
    expect(element.querySelector('[role="status"]')?.textContent).toBe('');
    await act(async () => settleTimeline());
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('shows the agents a turn handed work to as cards, and follows one in the drawer', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let completed = false;
  let childReads = 0;
  const api = {
    messages: async (_profileId: string, sessionId: string) => {
      if (sessionId === 'child-session') childReads++;
      return [
        {
          id: sessionId === 'parent-session' ? 'parent-message' : 'child-message',
          profileId: 'profile',
          sessionId,
          runId: sessionId === 'parent-session' ? 'parent-run' : 'child-run',
          role:
            sessionId === 'parent-session' || !completed
              ? ('user' as const)
              : ('assistant' as const),
          content:
            sessionId === 'parent-session' || !completed ? 'Check the build.' : 'Build passed.',
          createdAt: '2026-09-22T00:00:00Z',
        },
      ];
    },
    activities: async () => [],
    conversationSubagents: async () => [
      {
        runId: 'child-run',
        parentRunId: 'parent-run',
        sessionId: 'child-session',
        name: 'Verifier',
        role: 'execute' as const,
        status: completed ? ('completed' as const) : ('running' as const),
        input: 'Check the build.',
        tier: 'deep' as const,
        tierBy: 'jev' as const,
        modelSelection: { providerId: 'provider', modelId: 'claude-opus-5-5' },
        progress: completed
          ? undefined
          : {
              phase: 'tool' as const,
              tool: 'run_command',
              text: '',
              steps: 2,
              updatedAt: '2026-09-22T00:00:30Z',
            },
        ...(completed ? { output: 'Build passed.' } : {}),
        createdAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T00:01:00Z',
      },
    ],
    timeline: async () => [],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const page = (revision = 0) => (
    <>
      <History api={api} profileId="profile" sessionId="parent-session" revision={revision} />
      <CrewDrawer api={api} profileId="profile" />
    </>
  );
  try {
    await act(async () => root.render(page()));
    const card = element.querySelector<HTMLButtonElement>('.crew-card');
    expect(card?.textContent).toContain('Verifier');
    expect(card?.textContent).toContain('Running a command');
    expect(card?.textContent).toContain('Deep');
    expect(card?.textContent).toContain('Claude Opus 5.5');
    // The transcript is read only for the agent the owner follows.
    expect(childReads).toBe(0);
    expect(element.querySelector('.crew-drawer')).toBeNull();

    await act(async () => card?.click());
    const drawer = element.querySelector('.crew-drawer');
    expect(childReads).toBe(1);
    expect(card?.getAttribute('aria-pressed')).toBe('true');
    expect(drawer?.textContent).not.toContain('Jev picked');
    expect(drawer?.querySelector('[role="status"]')?.textContent).toContain('Working');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');

    completed = true;
    await act(async () => root.render(page(1)));
    // The outcome stays in the card's status slot; the report is read in the drawer.
    expect(card?.textContent).not.toContain('Build passed.');
    expect(card?.querySelector('.work-mark')).not.toBeNull();
    expect(element.querySelector('.crew-drawer')?.textContent).toContain('Build passed.');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(element.querySelector('.crew-drawer')).toBeNull();
    expect(document.activeElement).toBe(card);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('keeps agent status in the card and inspector without a follow dock', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let status: 'running' | 'completed' = 'running';
  const api = {
    messages: async () => [
      {
        id: 'parent-message',
        profileId: 'profile',
        sessionId: 'parent-session',
        runId: 'parent-run',
        role: 'assistant' as const,
        content: 'Handing it off.',
        createdAt: '2026-09-22T00:00:00Z',
      },
    ],
    activities: async () => [],
    conversationSubagents: async () => [
      {
        runId: 'child-run',
        parentRunId: 'parent-run',
        sessionId: 'child-session',
        name: 'Changelog entry',
        role: 'execute' as const,
        status,
        input: 'Add the entry.',
        tier: 'light' as const,
        tierBy: 'agent' as const,
        createdAt: '2026-09-22T00:00:00Z',
        updatedAt: '2026-09-22T00:00:20Z',
      },
    ],
    timeline: async () => [],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const page = (revision = 0) => (
    <>
      <History api={api} profileId="profile" sessionId="parent-session" revision={revision} />
      <CrewDrawer api={api} profileId="profile" />
    </>
  );
  try {
    await act(async () => root.render(page()));
    expect(element.querySelector('.crew-dock')).toBeNull();
    const card = element.querySelector<HTMLButtonElement>('.crew-card');
    expect(card?.querySelector('.crew-now')?.textContent).toBeTruthy();
    await act(async () => card?.click());
    expect(element.querySelector('.crew-drawer')?.textContent).not.toContain('Chosen by the agent');

    status = 'completed';
    await act(async () => root.render(page(1)));
    expect(element.querySelector('.crew-dock')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('shows a new run failure when the open session was previously completed', async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previous: Run = {
    id: 'previous',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'first',
    input: 'First request',
    output: 'Done.',
    status: 'completed',
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:01:00Z',
  };
  let latest = previous;
  const api = {
    messages: async () => [
      {
        id: 'message',
        profileId: 'profile',
        sessionId: 'session',
        runId: latest.id,
        role: 'assistant' as const,
        content: latest.id === previous.id ? 'Done.' : 'Found it.',
        createdAt: latest.createdAt,
      },
    ],
    activities: async () => [previous, latest],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(
        <History api={api} profileId="profile" sessionId="session" initialRun={previous} />,
      );
    });
    expect(element.textContent).toContain('Done.');
    expect(element.textContent).not.toContain('Failed');

    latest = {
      ...previous,
      id: 'next',
      status: 'failed',
      output: undefined,
      error: 'The provider ended without a final response.',
      createdAt: '2026-09-22T00:02:00Z',
      updatedAt: '2026-09-22T00:03:00Z',
    };
    await act(async () => {
      hear?.({ type: 'run.failed' });
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(element.textContent).toContain('Found it.');
    expect(element.querySelector('.trouble-card')?.textContent).toContain(
      'Agent encountered an error',
    );
    expect(element.textContent).toContain('The provider ended without a final response.');
    expect(element.textContent).not.toContain('Completed');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.useRealTimers();
  }
});

it('keeps tool history visible when a failed run never wrote an answer', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const failed: Run = {
    id: 'failed-run',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'failed',
    input: 'Review the change',
    status: 'failed',
    error: 'The run failed.',
    createdAt: '2026-09-29T17:58:17Z',
    updatedAt: '2026-09-29T17:59:23Z',
  };
  let timelineFails = false;
  const api = {
    messages: async () => [
      {
        id: 'request',
        profileId: 'profile',
        sessionId: 'session',
        runId: failed.id,
        role: 'user' as const,
        content: 'Review the change',
        createdAt: failed.createdAt,
      },
    ],
    activities: async () => [failed],
    timeline: async () => {
      if (timelineFails) throw new Error('Gateway time-out');
      return [
        {
          runId: failed.id,
          steps: [
            {
              toolCallId: 'tool-1',
              toolName: 'read_artifact',
              status: 'done' as const,
              startedAt: '2026-09-29T17:58:18Z',
              finishedAt: '2026-09-29T17:58:19Z',
            },
          ],
        },
      ];
    },
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" />),
    );
    openTraces(element);
    expect(element.textContent).toContain('Review the change');
    expect(element.querySelector('.thought-trace')?.textContent).toContain(
      'Reading a large result',
    );
    timelineFails = true;
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" revision={1} />),
    );
    expect(element.querySelector('.thought-trace')?.textContent).toContain(
      'Reading a large result',
    );
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('renders consecutive commentary as one Markdown answer', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const at = '2026-09-29T17:58:17Z';
  const api = {
    messages: async () => [
      {
        id: 'request',
        profileId: 'profile',
        sessionId: 'session',
        runId: 'answer',
        role: 'user' as const,
        content: 'Describe bot mode.',
        createdAt: at,
      },
      {
        id: 'opening',
        profileId: 'profile',
        sessionId: 'session',
        runId: 'answer',
        role: 'assistant' as const,
        content: 'In **Bots** mode, each bot could be a contact with:',
        createdAt: '2026-09-29T17:58:18Z',
      },
      {
        id: 'list',
        profileId: 'profile',
        sessionId: 'session',
        runId: 'answer',
        role: 'assistant' as const,
        content: '- A name, avatar and description.\n- Its own instructions.',
        createdAt: '2026-09-29T17:58:19Z',
      },
      {
        id: 'closing',
        profileId: 'profile',
        sessionId: 'session',
        runId: 'answer',
        role: 'assistant' as const,
        content: 'Each could use its own model and tools.',
        createdAt: '2026-09-29T17:58:20Z',
      },
    ],
    activities: async () => [],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" />),
    );

    const answer = element.querySelector('.chat-line.theirs .chat-text');
    expect(element.querySelectorAll('.chat-line.theirs')).toHaveLength(1);
    expect(answer?.querySelector('strong')?.textContent).toBe('Bots');
    expect(answer?.querySelectorAll('ul li')).toHaveLength(2);
    expect(answer?.textContent).toContain('Each could use its own model and tools.');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('lays a turn out in the order it happened, its working line at the end', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const working: Run = {
    id: 'working-run',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'working',
    input: 'Add a test',
    status: 'running',
    progress: {
      phase: 'tool',
      tool: 'run_command',
      text: '',
      steps: 2,
      updatedAt: '2026-09-29T17:58:22Z',
    },
    createdAt: '2026-09-29T17:58:17Z',
    updatedAt: '2026-09-29T17:58:22Z',
  };
  const message = (id: string, role: 'user' | 'assistant', content: string, at: string) => ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    runId: working.id,
    role,
    content,
    createdAt: at,
  });
  const api = {
    // What the agent said before each tool is already a message while the turn goes on.
    messages: async () => [
      message('request', 'user', 'Add a test', '2026-09-29T17:58:17Z'),
      message('said', 'assistant', 'I will add the test.', '2026-09-29T17:58:18Z'),
      message('next', 'assistant', 'Now running the suite.', '2026-09-29T17:58:21Z'),
    ],
    activities: async () => [working],
    timeline: async () => [
      {
        runId: working.id,
        steps: [
          {
            toolCallId: 'edit-1',
            toolName: 'edit_file',
            status: 'done' as const,
            startedAt: '2026-09-29T17:58:19Z',
            finishedAt: '2026-09-29T17:58:20Z',
            diff: {
              path: 'src/a.ts',
              additions: 1,
              deletions: 0,
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 2,
                  lines: [
                    { kind: 'context' as const, old: 1, new: 1, text: 'const a = 1;' },
                    { kind: 'add' as const, new: 2, text: 'const b = 2;' },
                  ],
                },
              ],
            },
          },
          {
            toolCallId: 'command-1',
            toolName: 'run_command',
            status: 'running' as const,
            startedAt: '2026-09-29T17:58:22Z',
          },
        ],
      },
    ],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const follows = (first: Node | null | undefined, second: Node | null | undefined) =>
    Boolean(
      first && second && first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  const said = (text: string) =>
    [...element.querySelectorAll('.chat-text')].find((item) => item.textContent?.includes(text));

  try {
    await act(async () =>
      root.render(
        <History api={api} profileId="profile" sessionId="session" initialRun={working} />,
      ),
    );
    openTraces(element);
    openTools(element);
    const lines = [...element.querySelectorAll('.thought-line')];
    const diff = element.querySelector('.code-diff');
    expect(lines).toHaveLength(2);
    expect(element.querySelectorAll('.code-diff')).toHaveLength(1);

    // The edit sits under the line that announced it, before the next thing said.
    const [settled, live] = lines;
    expect(settled?.hasAttribute('data-working')).toBe(false);
    expect(follows(said('I will add the test.'), settled)).toBe(true);
    expect(follows(settled, diff)).toBe(true);
    expect(follows(diff, said('Now running the suite.'))).toBe(true);

    // What it is doing now is at the end, with only the tools since its last line.
    expect(live?.hasAttribute('data-working')).toBe(true);
    expect(follows(said('Now running the suite.'), live)).toBe(true);
    expect(live?.textContent).toContain('Running a command');
    expect(live?.textContent).not.toContain('Editing a file');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('keeps the files a finished run changed once the next run starts', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const next: Run = {
    id: 'next-run',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'next',
    input: 'Now the docs',
    status: 'running',
    createdAt: '2026-09-29T18:00:00Z',
    updatedAt: '2026-09-29T18:00:01Z',
  };
  const message = (
    id: string,
    runId: string,
    role: 'user' | 'assistant',
    content: string,
    at: string,
  ) => ({ id, profileId: 'profile', sessionId: 'session', runId, role, content, createdAt: at });
  const api = {
    messages: async () => [
      message('ask', 'done-run', 'user', 'Fix the bug', '2026-09-29T17:58:00Z'),
      message('fixed', 'done-run', 'assistant', 'Fixed it.', '2026-09-29T17:59:00Z'),
      message('again', next.id, 'user', 'Now the docs', '2026-09-29T18:00:00Z'),
    ],
    activities: async () => [next],
    timeline: async () => [
      {
        runId: 'done-run',
        steps: [
          {
            toolCallId: 'edit-1',
            toolName: 'edit_file',
            status: 'done' as const,
            startedAt: '2026-09-29T17:58:10Z',
            finishedAt: '2026-09-29T17:58:20Z',
            diff: { path: 'src/a.ts', additions: 1, deletions: 0, hunks: [] },
          },
        ],
      },
    ],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" initialRun={next} />),
    );
    const summary = element.querySelector('.run-change-summary');
    expect(summary?.textContent).toContain('a.ts');
    expect(element.querySelectorAll('.run-change-summary')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('keeps the work done before a message sent mid-turn above it, live and once the turn ends', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const working: Run = {
    id: 'steered-run',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'steered',
    input: 'Open an issue',
    status: 'running',
    progress: {
      phase: 'tool',
      tool: 'web_search',
      text: '',
      steps: 2,
      updatedAt: '2026-09-29T18:06:00Z',
    },
    createdAt: '2026-09-29T18:00:00Z',
    updatedAt: '2026-09-29T18:06:00Z',
  };
  const message = (id: string, role: 'user' | 'assistant', content: string, at: string) => ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    runId: working.id,
    role,
    content,
    createdAt: at,
  });
  let active = [working];
  const api = {
    messages: async () => [
      message('request', 'user', 'Open an issue', '2026-09-29T18:00:00Z'),
      message('said', 'assistant', 'Drafting the issue.', '2026-09-29T18:00:01Z'),
      // Sent six minutes into the turn, which takes it in as it runs.
      message('steer', 'user', 'Leave the parent out', '2026-09-29T18:06:00Z'),
    ],
    activities: async () => active,
    timeline: async () => [
      {
        runId: working.id,
        steps: [
          {
            toolCallId: 'before',
            toolName: 'read_file',
            status: 'done' as const,
            startedAt: '2026-09-29T18:00:02Z',
            finishedAt: '2026-09-29T18:05:59Z',
          },
          {
            toolCallId: 'after',
            toolName: 'fetch_url',
            status: 'running' as const,
            startedAt: '2026-09-29T18:06:01Z',
          },
        ],
      },
    ],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const follows = (first: Node | null | undefined, second: Node | null | undefined) =>
    Boolean(
      first && second && first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  const text = (words: string) =>
    [...element.querySelectorAll('.chat-text')].find((item) => item.textContent?.includes(words));
  const line = (words: string) =>
    [...element.querySelectorAll('.thought-line')].find((item) =>
      item.textContent?.includes(words),
    );

  try {
    await act(async () =>
      root.render(
        <History api={api} profileId="profile" sessionId="session" initialRun={working} />,
      ),
    );
    openTraces(element);
    expect(follows(text('Drafting the issue.'), line('Reading a file'))).toBe(true);
    expect(follows(line('Reading a file'), text('Leave the parent out'))).toBe(true);
    const live = element.querySelector('.thought-line[data-working]');
    expect(follows(text('Leave the parent out'), live)).toBe(true);
    expect(live?.textContent).not.toContain('Reading a file');

    // Ended: the same order, nothing moved.
    active = [];
    await act(async () =>
      root.render(
        <History
          api={api}
          profileId="profile"
          sessionId="session"
          initialRun={working}
          revision={1}
        />,
      ),
    );
    expect(element.querySelector('.thought-line[data-working]')).toBeNull();
    openTraces(element);
    expect(follows(line('Reading a file'), text('Leave the parent out'))).toBe(true);
    expect(follows(text('Leave the parent out'), line('Reading a page'))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('shows the agent starting as soon as a message is sent, before the gateway answers', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let deliver: (run: { id: string }) => void = () => {};
  let started = false;
  const queued: Run = {
    id: 'new-run',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'new',
    input: 'Hello',
    status: 'queued',
    createdAt: '2026-10-30T00:00:01Z',
    updatedAt: '2026-10-30T00:00:01Z',
  };
  const api = {
    messages: async () =>
      started
        ? [
            {
              id: 'hello',
              profileId: 'profile',
              sessionId: 'session',
              runId: queued.id,
              role: 'user' as const,
              content: 'Hello',
              createdAt: '2026-10-30T00:00:01Z',
            },
          ]
        : [],
    activities: async () => (started ? [queued] : []),
    timeline: async () => [],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const working = () => element.querySelector('.thought-line[data-working]')?.textContent ?? '';

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" />),
    );
    expect(working()).toBe('');

    await act(async () =>
      sendNow({
        sessionId: 'session',
        text: 'Hello',
        mediaIds: [],
        deliver: () => new Promise((resolve) => (deliver = resolve)),
        delivered: () => {},
      }),
    );
    // Still on its way: the agent is already there, starting.
    expect(working()).toContain('Starting');

    // Taken: the turn the gateway made is what shows from the next read on.
    started = true;
    await act(async () => deliver({ id: queued.id }));
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" revision={1} />),
    );
    expect(working()).toContain('Starting');
    expect(element.querySelectorAll('.thought-line[data-working]')).toHaveLength(1);

    // Over before the panel saw it at work: nothing is left starting.
    started = false;
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" revision={2} />),
    );
    expect(working()).toBe('');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    useOutbox.setState({ items: [] });
  }
});

it('shows the agent starting on /compact at once, without the command, unless it failed', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const api = {
    messages: async () => [],
    activities: async () => [],
    timeline: async () => [],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const working = () => element.querySelector('.thought-line[data-working]')?.textContent ?? '';
  let refuse: (error: Error) => void = () => {};

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" />),
    );
    await act(async () =>
      sendNow({
        sessionId: 'session',
        text: '/compact',
        mediaIds: [],
        deliver: () => new Promise((_, reject) => (refuse = reject)),
        delivered: () => {},
      }),
    );
    // Heard at the click: nothing else told the owner it went, and they clicked again.
    expect(working()).toContain('Starting');
    expect(element.textContent).not.toContain('/compact');

    await act(async () => refuse(new Error('The gateway is unreachable.')));
    expect(element.textContent).toContain('/compact');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    useOutbox.setState({ items: [] });
  }
});

it('reads a turn at work again when the event stream falls silent', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const working: Run = {
    id: 'quiet-run',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'quiet',
    input: 'Build it',
    status: 'running',
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:00:00Z',
  };
  let reads = 0;
  const api = {
    messages: async () => {
      reads += 1;
      return [];
    },
    activities: async () => [working],
    timeline: async () => [],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(
        <History api={api} profileId="profile" sessionId="session" initialRun={working} />,
      ),
    );
    const first = reads;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(reads).toBe(first);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(reads).toBe(first + 1);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.useRealTimers();
  }
});

it('offers to retry a failed turn above the composer, and closes when dismissed', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const failed: Run = {
    id: 'failed-run',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'failed',
    input: 'Ship it',
    status: 'failed',
    error: 'The provider ended without a final response.',
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:01:00Z',
  };
  const api = {
    messages: async () => [
      {
        id: 'asked',
        profileId: 'profile',
        sessionId: 'session',
        runId: failed.id,
        role: 'user' as const,
        content: 'Ship it',
        createdAt: failed.createdAt,
      },
    ],
    activities: async () => [failed],
  };
  const retried: string[] = [];
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(
        <History
          api={api}
          profileId="profile"
          sessionId="session"
          initialRun={failed}
          retryRun={async (run) => {
            retried.push(run.id);
          }}
        />,
      ),
    );
    const card = element.querySelector('.trouble-card');
    expect(card?.textContent).toContain('Agent encountered an error');
    expect(card?.textContent).toContain('The provider ended without a final response.');

    const retry = [...(card?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Retry',
    );
    await act(async () => retry?.click());
    expect(retried).toEqual([failed.id]);

    await act(async () =>
      element.querySelector<HTMLButtonElement>('.trouble-card [aria-label="Dismiss"]')?.click(),
    );
    expect(element.querySelector('.trouble-card')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('does not duplicate a delivered answer while the writing snapshot is still in flight', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const sessionId = 'stream-handoff';
  const content = 'The update is ready.';
  const at = '2026-10-31T10:00:00Z';
  const live = {
    id: 'handoff-run',
    profileId: 'profile',
    sessionId,
    status: 'running',
    createdAt: at,
    updatedAt: at,
    progress: { phase: 'writing', text: content, steps: 0, updatedAt: at },
  } as Run;
  const api = {
    messages: async () => [
      {
        id: 'delivered',
        profileId: 'profile',
        sessionId,
        role: 'assistant',
        runId: live.id,
        content,
        createdAt: at,
      },
    ],
    activities: async () => [live],
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(
        <History api={api} profileId="profile" sessionId={sessionId} initialRun={live} />,
      ),
    );
    expect(element.querySelectorAll('.chat-text')).toHaveLength(1);
    expect(element.querySelector('.chat-text')?.textContent).toBe(content);
    expect(element.querySelector('.pending')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('keeps spawned agents before text written later when the streamed answer becomes history', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  stillMotion();
  let finished = false;
  const reply = 'I launched the agents. Their reports will arrive here.';
  const run = () =>
    ({
      id: 'ordered-parent',
      sessionId: 'ordered',
      profileId: 'profile',
      status: finished ? 'completed' : 'running',
      createdAt: '2026-10-31T10:00:00Z',
      updatedAt: '2026-10-31T10:00:04Z',
      progress: { phase: 'writing', text: reply, steps: 1, updatedAt: '2026-10-31T10:00:03Z' },
    }) as Run;
  const api = {
    messages: async () => [
      {
        id: 'request',
        profileId: 'profile',
        sessionId: 'ordered',
        runId: 'ordered-parent',
        role: 'user',
        content: 'Delegate the research.',
        createdAt: '2026-10-31T10:00:00Z',
      },
      ...(finished
        ? [
            {
              id: 'answer',
              profileId: 'profile',
              sessionId: 'ordered',
              runId: 'ordered-parent',
              role: 'assistant',
              content: reply,
              createdAt: '2026-10-31T10:00:04Z',
            },
          ]
        : []),
    ],
    activities: async () => [run()],
    conversationSubagents: async () => [
      {
        runId: 'ordered-child',
        sessionId: 'child',
        parentRunId: 'ordered-parent',
        name: 'Researcher',
        role: 'execute',
        status: finished ? 'completed' : 'running',
        input: 'Research.',
        createdAt: '2026-10-31T10:00:01Z',
        updatedAt: '2026-10-31T10:00:04Z',
      },
    ],
    timeline: async () => [],
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const render = (revision: number) =>
    root.render(
      <History
        api={api}
        profileId="profile"
        sessionId="ordered"
        initialRun={run()}
        revision={revision}
      />,
    );
  try {
    await act(async () => render(0));
    const beforeAnswer = () => {
      const crew = element.querySelector('.crew');
      const answer = [...element.querySelectorAll('.chat-text')].find(
        (item) => item.textContent === reply,
      );
      expect(crew).not.toBeNull();
      expect(answer).toBeDefined();
      expect(
        (crew?.compareDocumentPosition(answer as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(element.querySelectorAll('.crew-card')).toHaveLength(1);
    };
    beforeAnswer();
    finished = true;
    await act(async () => render(1));
    beforeAnswer();
    expect(element.querySelector('.crew-now')?.textContent).toBe('Completed');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});

it('reads the open chat again when it is asked to, keeping what it showed until then', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const said = (content: string) => ({
    id: content,
    profileId: 'profile-reload',
    sessionId: 'chat-reload',
    role: 'assistant' as const,
    content,
    createdAt: '2026-10-31T10:00:00.000Z',
  });
  let answer = 'First answer';
  const messages = vi.fn(async () => [said(answer)]);
  const api = { messages, activities: async () => [] } as unknown as GatewayApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<History api={api} profileId="profile-reload" sessionId="chat-reload" />),
  );
  expect(host.textContent).toContain('First answer');
  const before = messages.mock.calls.length;

  answer = 'Newer answer';
  await act(async () => useReconnect.getState().reloadChat());

  expect(messages.mock.calls.length).toBe(before + 1);
  expect(host.textContent).toContain('Newer answer');
  expect(toast.success).toHaveBeenCalledWith('Chat reloaded.');
  await act(async () => root.unmount());
  host.remove();
});

it('asks for an ended turn’s tools once, and for the turn at work on every read', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const run = (id: string, status: Run['status'], createdAt: string): Run => ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    requestKey: id,
    input: id,
    status,
    createdAt,
    updatedAt: createdAt,
  });
  const line = (id: string, runId: string, createdAt: string) => ({
    id,
    profileId: 'profile',
    sessionId: 'session',
    runId,
    role: 'assistant' as const,
    content: `Said in ${runId}.`,
    createdAt,
  });
  let live = run('live', 'running', '2026-11-07T10:00:00Z');
  const asked: string[][] = [];
  const api = {
    messages: async () => [
      // Older than every run the gateway lists: ended long ago.
      line('ancient-line', 'ancient', '2026-11-01T00:00:00Z'),
      line('done-line', 'done', '2026-11-07T09:00:00Z'),
      line('live-line', 'live', '2026-11-07T10:00:00Z'),
    ],
    activities: async () => [run('done', 'completed', '2026-11-07T09:00:00Z'), live],
    timeline: async (_profileId: string, _sessionId: string, runs?: string[]) => {
      asked.push([...(runs ?? [])].sort());
      return (runs ?? []).map((runId) => ({ runId, steps: [] }));
    },
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const step = async (type = 'run.step') =>
    act(async () => {
      hear?.({ type });
      await vi.advanceTimersByTimeAsync(150);
    });

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" initialRun={live} />),
    );
    expect(asked).toEqual([['ancient', 'done', 'live']]);
    await step();
    expect(asked.at(-1)).toEqual(['live']);
    // Its last tools are read once more as it ends, then never again.
    live = { ...live, status: 'completed' };
    await step('run.completed');
    expect(asked.at(-1)).toEqual(['live']);
    const reads = asked.length;
    await step();
    expect(asked).toHaveLength(reads);
    expect(element.textContent).toContain('Said in live.');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.useRealTimers();
  }
});

it('reads one at a time, and once more for whatever was heard meanwhile', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  let open = 0;
  let most = 0;
  let reads = 0;
  let release: (() => void) | undefined;
  const api = {
    messages: async () => {
      reads += 1;
      open += 1;
      most = Math.max(most, open);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      open -= 1;
      return [];
    },
    activities: async () => [],
    timeline: async () => [],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" />),
    );
    expect(reads).toBe(1);
    for (let heard = 0; heard < 3; heard++) {
      await act(async () => {
        hear?.({ type: 'run.step' });
        await vi.advanceTimersByTimeAsync(200);
      });
    }
    expect(reads).toBe(1);
    await act(async () => release?.());
    expect(reads).toBe(2);
    await act(async () => release?.());
    expect(reads).toBe(2);
    expect(most).toBe(1);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.useRealTimers();
  }
});

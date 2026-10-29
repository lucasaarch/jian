import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GatewayApi, Run } from '../../lib/api';
import { CrewDrawer } from './crew';
import { History } from './history';

let hear: ((event: { type: string }) => void) | undefined;
vi.mock('../../lib/events', () => ({
  subscribe: (listener: () => void) => {
    hear = listener;
    return () => {
      hear = undefined;
    };
  },
}));

it('centers a spinner while a conversation is loading', async () => {
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
    expect(element.querySelector('.message-history.loading .history-loading .spin')).not.toBeNull();
    expect(element.textContent).not.toContain('Loading the history');
    await act(async () => settle([]));
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
    expect(drawer?.textContent).toContain('Jev picked Deep');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');

    completed = true;
    await act(async () => root.render(page(1)));
    // A finished card says so by its mark alone; the report is read in the drawer.
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

it('keeps a dock above the composer only while an agent works, and it opens the drawer', async () => {
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
    const dock = element.querySelector<HTMLButtonElement>('.crew-dock');
    expect(dock?.textContent).toContain('1 agent working');

    await act(async () => dock?.click());
    expect(element.querySelector('.crew-drawer')?.textContent).toContain('Chosen by the agent');

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
    expect(element.textContent).toContain('Failed');
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

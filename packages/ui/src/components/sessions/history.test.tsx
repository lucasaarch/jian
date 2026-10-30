import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GatewayApi, Run } from '../../lib/api';
import { CrewDrawer } from './crew-drawer';
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

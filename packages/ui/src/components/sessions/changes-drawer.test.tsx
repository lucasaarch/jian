import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeDiff, GatewayApi, ToolStep } from '../../lib/api';
import { GatewayAnswer } from '../../lib/api/result';
import { publish } from '../../lib/events';
import { useCrew } from '../../lib/stores/crew';
import { ChangesDrawer } from './changes-drawer';

const path = 'src/pricing.ts';
const runId = 'run-1';
const toolCallId = 'edit-1';
const diff: CodeDiff = {
  path,
  language: 'typescript',
  additions: 1,
  deletions: 1,
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [
        { kind: 'del', old: 1, text: 'const price = 1;' },
        { kind: 'add', new: 1, text: 'const price = 2;' },
      ],
    },
  ],
};
const step: ToolStep = {
  toolCallId,
  toolName: 'edit_file',
  status: 'done',
  startedAt: '2026-10-30T10:00:00.000Z',
  finishedAt: '2026-10-30T10:00:01.000Z',
  diff,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useCrew.getState().close();
});

async function render(api: Partial<GatewayApi>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChangesDrawer api={api as GatewayApi} profileId="profile" />
      </QueryClientProvider>,
    ),
  );
}

async function settled(done: () => boolean) {
  for (let tries = 0; tries < 100 && !done(); tries += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

it('lists a project’s current changed files and opens the selected checkout diff', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges();
  const api = {
    sessionChanges: vi.fn(async (_profile: string, _session: string, selected?: string) => ({
      files: selected
        ? [{ path, status: 'modified' as const, diff }]
        : [{ path, status: 'modified' as const }],
      truncated: false,
    })),
    timeline: vi.fn(async () => []),
  };

  await render(api);
  await settled(() => Boolean(container.querySelector('button')?.textContent?.includes(path)));
  expect(container.textContent).toContain('1 changed file');
  const file = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(path),
  );
  await act(async () => file?.click());
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  expect(api.sessionChanges).toHaveBeenLastCalledWith(
    'profile',
    'session',
    path,
    undefined,
    undefined,
  );
  expect(api.timeline).not.toHaveBeenCalled();
  expect(container.querySelector('.code-diff-head')?.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('.code-diff-line code')?.textContent).toBe('const price = 1;');
});

it('reports checkout diff errors and retries without showing a saved diff for a current file', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges({ runId, toolCallId, path });
  let selectedCalls = 0;
  const sessionChanges = vi.fn(async (_profile: string, _session: string, selected?: string) => {
    if (selected) {
      selectedCalls += 1;
      if (selectedCalls === 1) throw new Error('current diff is unavailable');
      return { files: [{ path, status: 'modified' as const, diff }], truncated: false };
    }
    return { files: [{ path, status: 'modified' as const }], truncated: false };
  });
  const api = { sessionChanges, timeline: vi.fn(async () => [{ runId, steps: [step] }]) };

  await render(api);
  await settled(
    () => container.querySelector('[role="alert"]')?.textContent === 'current diff is unavailable',
  );
  expect(api.timeline).not.toHaveBeenCalled();
  expect(container.querySelector('.code-diff-path')).toBeNull();

  const retry = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Try again'),
  );
  await act(async () => retry?.click());
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  expect(api.sessionChanges).toHaveBeenCalledTimes(3);
  expect(api.timeline).not.toHaveBeenCalled();
  expect(container.querySelector('.code-diff-path')?.textContent).toBe(path);
});

it('does not use a saved diff from another run with a matching file path', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges({ runId, toolCallId, path });
  const api = {
    sessionChanges: vi.fn(async () => ({ files: [], truncated: false })),
    timeline: vi.fn(async () => [{ runId: 'different-run', steps: [step] }]),
  };

  await render(api);
  await settled(() => container.textContent?.includes('saved diff is unavailable') ?? false);

  expect(container.querySelector('.code-diff-path')).toBeNull();
  expect(container.textContent).toContain('This file is no longer changed in the current checkout');
  expect(api.timeline).toHaveBeenCalledTimes(1);
});

it('reports a checkout listing failure for a linked file and retries before loading its diff', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges({ runId, toolCallId, path });
  const sessionChanges = vi.fn(async (_profile: string, _session: string, selected?: string) => ({
    files: selected
      ? [{ path, status: 'modified' as const, diff }]
      : [{ path, status: 'modified' as const }],
    truncated: false,
  }));
  sessionChanges.mockRejectedValueOnce(new Error('checkout is unavailable'));
  const api = { sessionChanges, timeline: vi.fn(async () => []) };

  await render(api);
  await settled(
    () => container.querySelector('[role="alert"]')?.textContent === 'checkout is unavailable',
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('checkout is unavailable');

  const retry = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Try again'),
  );
  await act(async () => retry?.click());
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  expect(api.sessionChanges).toHaveBeenCalledTimes(3);
  expect(api.timeline).not.toHaveBeenCalled();
  expect(container.querySelector('.code-diff-path')?.textContent).toBe(path);
});

it('falls back to the run’s saved diff when the file is no longer changed and retries timeline errors', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges({ runId, toolCallId, path });
  const timeline = vi.fn(async () => [{ runId, steps: [step] }]);
  timeline.mockRejectedValueOnce(new Error('timeline is unavailable'));
  const api = {
    sessionChanges: vi.fn(async () => ({ files: [], truncated: false })),
    timeline,
  };

  await render(api);
  await settled(
    () => container.querySelector('[role="alert"]')?.textContent === 'timeline is unavailable',
  );
  expect(api.sessionChanges).toHaveBeenCalledTimes(1);

  const retry = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Try again'),
  );
  await act(async () => retry?.click());
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  expect(api.timeline).toHaveBeenCalledTimes(2);
  expect(container.querySelector('.code-diff-path')?.textContent).toBe(path);
  expect(container.querySelector('.code-diff-line code')?.textContent).toBe('const price = 1;');
});

it('refreshes a current diff, drops it when the file is no longer changed, and goes back to the list', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges();
  let listings = 0;
  const api = {
    sessionChanges: vi.fn(async (_profile: string, _session: string, selected?: string) => {
      if (selected)
        return { files: [{ path, status: 'modified' as const, diff }], truncated: false };
      listings += 1;
      return {
        files: listings === 1 ? [{ path, status: 'modified' as const }] : [],
        truncated: false,
      };
    }),
    timeline: vi.fn(async () => []),
  };

  await render(api);
  await settled(() =>
    Boolean(
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(path),
      ),
    ),
  );
  const file = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(path),
  );
  await act(async () => file?.click());
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  await act(async () => {
    publish({ id: 1, type: 'run.step' });
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  await settled(() => container.textContent?.includes('This file is no longer changed') ?? false);
  expect(container.querySelector('.code-diff-path')).toBeNull();

  await act(async () => useCrew.getState().showChanges());
  await settled(() => container.textContent?.includes('No uncommitted changes') ?? false);
  expect(container.textContent).toContain('No uncommitted changes in this project.');
  expect(api.timeline).not.toHaveBeenCalled();
});

it('opens the saved tool diff for a file link in a conversation without a project', async () => {
  useCrew.getState().show('session', []);
  useCrew.getState().showChanges({ runId, toolCallId, path });
  const api = {
    sessionChanges: vi.fn(),
    timeline: vi.fn(async () => [{ runId, steps: [step] }]),
  };

  await render(api);
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  expect(api.sessionChanges).not.toHaveBeenCalled();
  expect(api.timeline).toHaveBeenCalledWith('profile', 'session', [runId]);
  expect(container.querySelector('.code-diff-path')?.textContent).toBe(path);
  expect(container.querySelector('.code-diff-head')?.getAttribute('aria-expanded')).toBe('true');
  await act(async () => {
    publish({ id: 1, type: 'run.step' });
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  await settled(() => api.timeline.mock.calls.length === 2);
  expect(api.sessionChanges).not.toHaveBeenCalled();
});

it('reports when there are no current changes in a project', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges();
  const api = {
    sessionChanges: vi.fn(async () => ({ files: [], truncated: false })),
    timeline: vi.fn(async () => []),
  };

  await render(api);
  await settled(() => container.textContent?.includes('No uncommitted changes') ?? false);

  expect(container.textContent).toContain('No uncommitted changes in this project.');
});

const openedFile = async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges({ path });
  await render({
    sessionChanges: vi.fn(async () => ({
      files: [{ path, status: 'modified' as const, diff }],
      truncated: false,
    })),
    timeline: vi.fn(async () => []),
  });
  await settled(() => Boolean(container.querySelector('.code-diff-path')));
};

it('says a file’s path once, and leaves naming the tab to the tab', async () => {
  await openedFile();

  expect(container.textContent?.split(path)).toHaveLength(2);
  expect(container.textContent).not.toContain('Changes');
  // Cut for room, the file's name stays and the whole path is a hover away.
  const shown = container.querySelector('.code-diff-path');
  expect(shown?.getAttribute('title')).toBe(path);
  expect(shown?.querySelector('.code-diff-file')?.textContent).toBe(path.split('/').at(-1));
});

it('wraps a file’s long lines at the owner’s word', async () => {
  await openedFile();
  const drawer = () => container.querySelector('.crew-drawer');
  const wrap = () => container.querySelector<HTMLElement>('[role="switch"]');

  expect(wrap()?.getAttribute('aria-label')).toBe('Wrap lines');
  expect(drawer()?.hasAttribute('data-wrap')).toBe(false);

  await act(async () => wrap()?.click());

  expect(drawer()?.hasAttribute('data-wrap')).toBe(true);
});

it('offers wrapping only where there is a file to wrap', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges();
  await render({
    sessionChanges: vi.fn(async () => ({
      files: [{ path, status: 'modified' as const }],
      truncated: false,
    })),
    timeline: vi.fn(async () => []),
  });
  await settled(() => Boolean(container.textContent?.includes('1 changed file')));

  expect(container.querySelector('[role="switch"]')).toBeNull();
});

const visible = () => {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove();
  return copy.textContent ?? '';
};

it('outlines a file while it is read, instead of saying so in words', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges({ path });
  let answer!: (read: { files: { path: string; status: 'modified'; diff: CodeDiff }[] }) => void;
  await render({
    sessionChanges: vi.fn(async (_profile: string, _session: string, selected?: string) =>
      selected
        ? new Promise<{
            files: { path: string; status: 'modified'; diff: CodeDiff }[];
            truncated: false;
          }>((resolve) => {
            answer = (read) => resolve({ ...read, truncated: false });
          })
        : { files: [{ path, status: 'modified' as const }], truncated: false },
    ),
    timeline: vi.fn(async () => []),
  });
  await settled(() => Boolean(answer));

  expect(container.querySelector('[aria-busy="true"] .code-diff')).not.toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading diff…');
  expect(visible()).not.toContain('Loading');

  await act(async () => answer({ files: [{ path, status: 'modified', diff }] }));
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
});

it('outlines the list of files while it is read', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges();
  await render({
    sessionChanges: vi.fn(() => new Promise<never>(() => {})),
    timeline: vi.fn(async () => []),
  });

  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(visible()).not.toContain('Loading');
});

const readOf = () => ({
  files: [{ path, status: 'modified' as const, diff }],
  truncated: false,
});

it('keeps the file on screen while it is read again', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges({ path });
  let reads = 0;
  await render({
    sessionChanges: vi.fn(async (_profile: string, _session: string, selected?: string) => {
      if (selected) reads += 1;
      return selected && reads > 1 ? new Promise<ReturnType<typeof readOf>>(() => {}) : readOf();
    }),
    timeline: vi.fn(async () => []),
  });
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  await act(async () => publish({ id: 1, type: 'run.step' }));
  await settled(() => reads > 1);

  expect(container.querySelector('.code-diff-path')?.textContent).toBe(path);
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
});

it('reads the changes again when the conversation moves, and not for another one', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges();
  const sessionChanges = vi.fn(async () => readOf());
  await render({ sessionChanges, timeline: vi.fn(async () => []) });
  await settled(() => Boolean(container.textContent?.includes('1 changed file')));
  const before = sessionChanges.mock.calls.length;

  await act(async () => {
    publish({ id: 1, type: 'run.completed', data: { sessionId: 'another-session' } });
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  expect(sessionChanges.mock.calls.length).toBe(before);

  await act(async () => {
    publish({ id: 2, type: 'run.step' });
    publish({ id: 3, type: 'run.step' });
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
  // One read for a burst of events.
  expect(sessionChanges.mock.calls.length).toBe(before + 1);
});

it('notices what changed outside the agent, with nothing to press', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  try {
    useCrew.getState().show('session', [], 'project');
    useCrew.getState().showChanges();
    const sessionChanges = vi.fn(async () => readOf());
    await render({ sessionChanges, timeline: vi.fn(async () => []) });
    await act(async () => vi.advanceTimersByTimeAsync(100));
    const before = sessionChanges.mock.calls.length;

    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    expect(sessionChanges.mock.calls.length).toBeGreaterThan(before);
    expect(container.querySelector('[aria-label="Refresh changes"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('keeps what it has when reading again fails', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges({ path });
  let failing = false;
  await render({
    sessionChanges: vi.fn(async () => {
      if (failing) throw new Error('offline');
      return readOf();
    }),
    timeline: vi.fn(async () => []),
  });
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  failing = true;
  await act(async () => {
    publish({ id: 1, type: 'run.step' });
    await new Promise((resolve) => setTimeout(resolve, 700));
  });

  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('.code-diff-path')?.textContent).toBe(path);
});

it('keeps a folded file’s code out of reach, and eases it open', async () => {
  await openedFile();
  const head = container.querySelector<HTMLElement>('.code-diff-head');

  await act(async () => head?.click());
  expect(head?.getAttribute('aria-expanded')).toBe('false');
  // Still there to move, and folded it cannot be reached.
  expect(container.querySelector('.code-diff-line')?.closest('[inert]')).toBeTruthy();

  await act(async () => head?.click());
  expect(container.querySelector('.code-diff-line')?.closest('[inert]')).toBeNull();
});

it('offers no way back from a file: the list is reached from the Inspector’s own menu', async () => {
  await openedFile();

  expect(container.querySelector('[aria-label="Back to changed files"]')).toBeNull();
});

it('finds a saved diff in a turn older than the latest ones', async () => {
  useCrew.getState().show('session', []);
  useCrew.getState().showChanges({ runId, toolCallId, path });
  // A gateway answers the latest turns unless it is told which: this one is not among them.
  const timeline = vi.fn(async (_profile: string, _session: string, runs?: string[]) =>
    runs?.includes(runId) ? [{ runId, steps: [step] }] : [],
  );
  await render({ sessionChanges: vi.fn(), timeline });
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  expect(container.querySelector('.code-diff-path')?.textContent).toBe(path);
});

const many = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/module-${index}/File${index}.ts`,
    status: 'modified' as const,
  }));

const listed = async (files: ReturnType<typeof many>, truncated = false) => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges();
  const sessionChanges = vi.fn(async () => ({ files, truncated }));
  await render({ sessionChanges, timeline: vi.fn(async () => []) });
  // Not by its words: the outline says "Loading changed files…" to a screen reader.
  await settled(() => Boolean(container.querySelector('ul button')));
  return sessionChanges;
};

const filter = () => container.querySelector<HTMLInputElement>('input[placeholder="Filter files"]');

const type = (text: string) =>
  act(async () => {
    const input = filter();
    if (!input) throw new Error('No filter to type in');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const rows = () => container.querySelectorAll('ul button').length;

it('always offers the filter, however short the list', async () => {
  await listed(many(1));

  expect(filter()).not.toBeNull();
  expect(filter()?.disabled).toBe(false);
});

const savedStep = (id: string, file: string, startedAt: string): ToolStep => ({
  ...step,
  toolCallId: id,
  startedAt,
  diff: { ...diff, path: file },
});

const withoutProject = async (timeline: unknown[]) => {
  useCrew.getState().show('session', []);
  useCrew.getState().showChanges();
  const read = vi.fn(async () => timeline as never);
  await render({ sessionChanges: vi.fn(), timeline: read });
  return read;
};

it('lists what the conversation saved when it has no project, newest first, each file once', async () => {
  await withoutProject([
    {
      runId,
      steps: [
        savedStep('first', 'src/old.ts', '2026-10-29T10:00:00.000Z'),
        savedStep('second', 'src/both.ts', '2026-10-29T10:00:01.000Z'),
      ],
    },
    { runId: 'later', steps: [savedStep('third', 'src/both.ts', '2026-10-29T10:00:02.000Z')] },
  ]);
  await settled(() => rows() > 0);

  const listedPaths = [...container.querySelectorAll('ul button .font-mono')].map(
    (item) => item.textContent,
  );
  expect(listedPaths).toEqual(['src/both.ts', 'src/old.ts']);
  expect(container.textContent).toContain('2 changed files');
});

it('opens a saved file from the turn that last changed it', async () => {
  await withoutProject([
    { runId: 'earlier', steps: [savedStep('first', path, '2026-10-29T10:00:00.000Z')] },
    { runId, steps: [savedStep(toolCallId, path, '2026-10-29T10:00:01.000Z')] },
  ]);
  await settled(() => rows() > 0);

  await act(async () => container.querySelector<HTMLElement>('ul button')?.click());
  await settled(() => Boolean(container.querySelector('.code-diff-path')));

  const tab = useCrew.getState().tabs.find((item) => item.kind === 'changes');
  expect(tab).toMatchObject({ path, runId, toolCallId });
});

it('filters what was saved, and goes to that list from a file, with no project', async () => {
  useCrew.getState().show('session', []);
  useCrew.getState().showChanges({ runId, toolCallId, path });
  await render({
    sessionChanges: vi.fn(),
    timeline: vi.fn(async () => [
      {
        runId,
        steps: [
          { ...step, toolCallId, diff: { ...diff, path } },
          savedStep('other', 'docs/notes.md', '2026-10-29T10:00:02.000Z'),
        ],
      },
    ]),
  });
  await settled(() => Boolean(container.querySelector('.code-diff-path')));
  expect(filter()?.disabled).toBe(false);

  await type('notes');
  await settled(() => rows() > 0);

  expect(container.querySelector('.code-diff-path')).toBeNull();
  expect(rows()).toBe(1);
  expect(container.textContent).toContain('docs/notes.md');
});

it('says when a conversation with no project saved no changes', async () => {
  await withoutProject([{ runId, steps: [{ ...step, diff: undefined }] }]);
  await settled(() => Boolean(container.textContent?.includes('No file changes')));

  expect(container.textContent).toContain('No file changes');
  expect(rows()).toBe(0);
});

it('leaves out a change that did not go through', async () => {
  await withoutProject([{ runId, steps: [{ ...step, status: 'failed' }] }]);
  await settled(() => Boolean(container.textContent?.includes('No file changes')));

  expect(container.textContent).toContain('No file changes');
  expect(rows()).toBe(0);
});

it('filters by any part of the path, whatever its case, and says how many it left', async () => {
  await listed(many(12));

  await type('file1');

  // File1, File10 and File11.
  expect(rows()).toBe(3);
  expect(container.textContent).toContain('3 of 12 changed files');
});

it('sits beside the wrap switch, which only a file has', async () => {
  await listed(many(12));
  expect(container.querySelector('[role="switch"]')).toBeNull();

  await act(async () => useCrew.getState().showChanges({ path: many(12)[0]?.path }));
  await settled(() => Boolean(container.querySelector('[role="switch"]')));

  expect(filter()).not.toBeNull();
});

it('goes to the list when typing with a file open, keeping the keyboard in the field', async () => {
  await listed(many(12));
  await act(async () => useCrew.getState().showChanges({ path: many(12)[0]?.path }));
  await settled(() => Boolean(container.querySelector('[role="switch"]')));
  const field = filter();
  field?.focus();

  await type('file1');
  await settled(() => rows() > 0);

  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(rows()).toBe(3);
  expect(filter()).toBe(field);
  expect(document.activeElement).toBe(field);
});

it('remembers what was typed when the owner comes back to the list', async () => {
  await listed(many(12));
  await type('file1');

  await act(async () => useCrew.getState().showChanges({ path: many(12)[0]?.path }));
  await act(async () => useCrew.getState().showChanges());
  await settled(() => Boolean(filter()));

  expect(filter()?.value).toBe('file1');
  expect(rows()).toBe(3);
});

it('keeps the filter on screen while it applies, however short the list becomes', async () => {
  const files = many(12);
  let shrunk = false;
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges();
  await render({
    sessionChanges: vi.fn(async () => ({
      files: shrunk ? files.slice(0, 3) : files,
      truncated: false,
    })),
    timeline: vi.fn(async () => []),
  });
  await settled(() => Boolean(filter()));
  await type('file2');
  expect(rows()).toBe(1);

  shrunk = true;
  await act(async () => {
    publish({ id: 1, type: 'run.step' });
    await new Promise((resolve) => setTimeout(resolve, 700));
  });

  // Otherwise the list would stay narrowed by words the owner can no longer see or clear.
  expect(filter()?.value).toBe('file2');
});

it('says when nothing matches', async () => {
  await listed(many(12));

  await type('nothing-like-this');

  expect(rows()).toBe(0);
  expect(container.textContent).toContain('No changed file matches');
  expect(container.textContent).not.toContain('beyond what is listed');
});

it('warns that a cut list may hide what was searched for', async () => {
  await listed(many(12), true);

  await type('nothing-like-this');

  expect(container.textContent).toContain('beyond what is listed');
});

it('clears the filter on Escape before Escape closes anything', async () => {
  await listed(many(12));
  await type('file1');

  await act(async () =>
    filter()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );

  expect(filter()?.value).toBe('');
  expect(rows()).toBe(12);
  expect(useCrew.getState().opened).toBe(true);
});

describe('a gateway that cannot read the checkout at all', () => {
  const gone = new GatewayAnswer('This gateway does not have this yet. Update it to use it.', 404);

  it('opens the linked file from what the turn saved, says why, and offers nothing to retry', async () => {
    useCrew.getState().show('session', [], 'project');
    useCrew.getState().showChanges({ runId, toolCallId, path });
    const api = {
      sessionChanges: vi.fn(async () => {
        throw gone;
      }),
      timeline: vi.fn(async () => [{ runId, steps: [step] }]),
    };

    await render(api);
    await settled(() => Boolean(container.querySelector('.code-diff-path')));

    expect(container.querySelector('.code-diff-path')?.textContent).toBe(path);
    expect(container.textContent).toContain(gone.message);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Try again');
  });

  it('lists what the conversation saved instead of a failure', async () => {
    useCrew.getState().show('session', [], 'project');
    useCrew.getState().showChanges({});
    const api = {
      sessionChanges: vi.fn(async () => {
        throw gone;
      }),
      timeline: vi.fn(async () => [{ runId, steps: [step] }]),
    };

    await render(api);
    await settled(() => Boolean(container.textContent?.includes('1 changed file')));

    expect(container.textContent).toContain(path);
    expect(container.textContent).toContain(gone.message);
  });

  it('says only why when nothing was saved either', async () => {
    useCrew.getState().show('session', [], 'project');
    useCrew.getState().showChanges({});
    const api = {
      sessionChanges: vi.fn(async () => {
        throw gone;
      }),
      timeline: vi.fn(async () => []),
    };

    await render(api);
    await settled(() => Boolean(container.textContent?.includes(gone.message)));

    expect(container.textContent).not.toContain('Not Found');
    expect(container.textContent).not.toContain('Try again');
  });
});

it('says it waits for the gateway while reads are held, and reads once it answers', async () => {
  useCrew.getState().show('session', [], 'project');
  useCrew.getState().showChanges({ runId, toolCallId, path });
  const api = {
    sessionChanges: vi.fn(async (_profile: string, _session: string, selected?: string) => ({
      files: selected
        ? [{ path, status: 'modified' as const, diff }]
        : [{ path, status: 'modified' as const }],
      truncated: false,
    })),
    timeline: vi.fn(async () => []),
  };
  onlineManager.setOnline(false);

  try {
    await render(api);
    await settled(() => Boolean(container.textContent?.includes('Waiting for the gateway')));
    expect(api.sessionChanges).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();

    await act(async () => onlineManager.setOnline(true));
    await settled(() => Boolean(container.querySelector('.code-diff-path')));
    expect(container.textContent).not.toContain('Waiting for the gateway');
  } finally {
    onlineManager.setOnline(true);
  }
});

describe('with worktrees', () => {
  const tree = (name: string, place = 'gateway') => ({
    name,
    branch: `jian/${name}`,
    base: 'main',
    source: '/work/harbor',
    path: `/data/worktrees/harbor-1a2b3c4d/${name}`,
    place,
    ahead: 1,
    behind: 0,
    uncommitted: 1,
    pullRequest: false,
  });

  it('reads a folder conversation’s worktree, which has no project', async () => {
    useCrew.getState().show('session', []);
    useCrew.getState().showChanges();
    const api = {
      sessionWorktrees: vi.fn(async () => [tree('brave-otter')]),
      sessionChanges: vi.fn(async () => ({
        files: [{ path, status: 'modified' as const }],
        truncated: false,
      })),
      timeline: vi.fn(async () => []),
    };

    await render(api as never);
    await settled(() => Boolean(container.textContent?.includes(path)));

    expect(api.sessionChanges).toHaveBeenCalledWith(
      'profile',
      'session',
      undefined,
      undefined,
      'brave-otter',
    );
    expect(api.timeline).not.toHaveBeenCalled();
    // One worktree needs no choosing.
    expect(container.querySelector('[aria-label="Worktree"]')).toBeNull();
  });

  it('asks which worktree when there are several', async () => {
    useCrew.getState().show('session', []);
    useCrew.getState().showChanges();
    const api = {
      sessionWorktrees: vi.fn(async () => [tree('brave-otter'), tree('calm-heron')]),
      sessionChanges: vi.fn(
        async (_p: string, _s: string, _f?: string, _w?: boolean, w?: string) => ({
          files: [
            { path: w === 'calm-heron' ? 'src/heron.ts' : path, status: 'modified' as const },
          ],
          truncated: false,
        }),
      ),
      timeline: vi.fn(async () => []),
    };

    await render(api as never);
    await settled(() => Boolean(container.textContent?.includes(path)));
    const picker = container.querySelector<HTMLElement>('[aria-label="Worktree"]');
    expect(picker?.textContent).toContain('brave-otter');

    await act(async () => picker?.click());
    const choice = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('calm-heron'),
    );
    await act(async () => choice?.click());
    await settled(() => Boolean(container.textContent?.includes('src/heron.ts')));

    expect(api.sessionChanges).toHaveBeenLastCalledWith(
      'profile',
      'session',
      undefined,
      undefined,
      'calm-heron',
    );
  });

  it('keeps the timeline for a worktree that is only on a machine', async () => {
    useCrew.getState().show('session', []);
    useCrew.getState().showChanges();
    const api = {
      sessionWorktrees: vi.fn(async () => [tree('brave-otter', crypto.randomUUID())]),
      sessionChanges: vi.fn(async () => ({ files: [], truncated: false })),
      timeline: vi.fn(async () => [{ runId, steps: [step] }]),
    };

    await render(api as never);
    await settled(() => Boolean(container.textContent?.includes(path)));

    expect(api.sessionChanges).not.toHaveBeenCalled();
    expect(api.timeline).toHaveBeenCalled();
  });
});

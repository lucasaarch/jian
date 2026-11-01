import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CodeDiff, GatewayApi, ToolStep } from '../../lib/api';
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

  expect(api.sessionChanges).toHaveBeenLastCalledWith('profile', 'session', path);
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

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh changes"]')?.click(),
  );
  await settled(() => container.textContent?.includes('This file is no longer changed') ?? false);
  expect(container.querySelector('.code-diff-path')).toBeNull();

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Back to changed files"]')?.click(),
  );
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
  expect(api.timeline).toHaveBeenCalledWith('profile', 'session');
  expect(container.querySelector('.code-diff-path')?.textContent).toBe(path);
  expect(container.querySelector('.code-diff-head')?.getAttribute('aria-expanded')).toBe('true');
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh changes"]')?.click(),
  );
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

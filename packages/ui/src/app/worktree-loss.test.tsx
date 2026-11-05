// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionWorktree } from '../lib/api';
import { WorktreeLoss } from './worktree-loss';

const read = vi.hoisted(() => vi.fn());
vi.mock('../lib/query/client', () => ({ panelApi: () => ({ sessionWorktrees: read }) }));

const tree = (name: string, uncommitted: number | null): SessionWorktree => ({
  name,
  branch: `jian/${name}`,
  base: 'main',
  source: '/work/harbor',
  path: `/data/worktrees/harbor-1a2b3c4d/${name}`,
  place: 'gateway',
  ahead: 0,
  behind: 0,
  uncommitted,
  pullRequest: false,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const text = async (worktrees: SessionWorktree[]) => {
  read.mockResolvedValue(worktrees);
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <WorktreeLoss profileId="profile" sessionId="session" />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  return host.textContent;
};

it('names the worktree and how many uncommitted files are lost', async () => {
  expect(await text([tree('brave-otter', 3)])).toBe(
    'Its worktree brave-otter has 3 uncommitted files, which are lost. Committed work stays on its branch.',
  );
});

it('counts them across several worktrees', async () => {
  expect(await text([tree('brave-otter', 3), tree('calm-heron', 1), tree('keen-lynx', null)])).toBe(
    'Its worktrees have 4 uncommitted files, which are lost. Committed work stays on its branches.',
  );
});

it('says nothing when nothing uncommitted is lost', async () => {
  expect(await text([tree('brave-otter', 0)])).toBe('');
  expect(await text([])).toBe('');
});

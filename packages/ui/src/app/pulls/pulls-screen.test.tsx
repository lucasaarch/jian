import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitHubPullRow } from '../../lib/api';
import { PullsScreen } from './pulls-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../platform/navigation', () => ({
  usePathname: () => '/agents/a1/pulls',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const read = vi.hoisted(() => ({
  githubIntegration: vi.fn(),
  githubRepositories: vi.fn(),
  githubPulls: vi.fn(),
  githubReviews: vi.fn(),
  profiles: async () => [],
}));
vi.mock('../../lib/query/client', () => ({ panelApi: () => read }));

const pull: GitHubPullRow = {
  owner: 'harbor-labs',
  repo: 'tides',
  number: 42,
  url: 'https://github.com/harbor-labs/tides/pull/42',
  title: 'Read the tide tables once',
  draft: false,
  headRef: 'tides',
  headSha: 'abc123',
  labels: [],
  reviewers: [],
  mergeable: 'clean',
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
};
const list = (pulls: GitHubPullRow[]) => ({ pulls, truncated: false, unreachable: [] });

/** A read of the pull requests that answers only when the test says so. */
function held() {
  let answer: (value: ReturnType<typeof list>) => void = () => {};
  read.githubPulls.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  return (value: ReturnType<typeof list>) => answer(value);
}

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  read.githubIntegration.mockReset().mockResolvedValue({ configured: true, accounts: [] });
  read.githubRepositories.mockReset().mockResolvedValue([]);
  read.githubPulls.mockReset();
  read.githubReviews.mockReset().mockResolvedValue({
    settings: { instructions: '', auto: false, drafts: false, repositories: [] },
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <PullsScreen profileId="a1" />
      </QueryClientProvider>,
    ),
  );
}

/** The query tells the screen on a timer of its own: waits, inside act, until it has. */
const until = (check: () => void) =>
  act(async () => {
    await vi.waitFor(check);
  });
const busy = () => host.querySelector('[aria-busy="true"]');
const status = () => [...host.querySelectorAll('[role="status"]')].map((item) => item.textContent);

it('draws the table in skeletons of a size while the first list is read', async () => {
  const answer = held();
  await show();

  const region = busy();
  expect(region?.querySelector('th')?.textContent).toBe('ID');
  const bars = [...(region?.querySelectorAll('[class*="animate-pulse"]') ?? [])];
  expect(bars.length).toBeGreaterThan(6);
  // A bar without a width is drawn zero wide in its flex line: the card looked empty.
  for (const bar of bars) expect(bar.className).toMatch(/(^|\s)(w-|size-)/);
  expect(status()).toContain('Loading pull requests…');

  answer(list([pull]));
  await until(() => expect(busy()).toBeNull());
  expect(host.textContent).toContain('Read the tide tables once');
});

it('keeps the list on screen, dimmed and busy, while another filter is read', async () => {
  read.githubPulls.mockResolvedValueOnce(list([pull]));
  await show();
  await until(() => expect(busy()).toBeNull());

  const answer = held();
  const needsReview = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === 'Needs review',
  );
  await act(async () => needsReview?.click());

  expect(read.githubPulls).toHaveBeenLastCalledWith({ filter: 'review' });
  expect(busy()?.className).toContain('opacity-50');
  expect(busy()?.textContent).toContain('Read the tide tables once');
  expect(status()).toContain('Updating pull requests…');

  answer(list([]));
  await until(() => expect(busy()).toBeNull());
  expect(host.textContent).toContain('No open pull requests.');
});

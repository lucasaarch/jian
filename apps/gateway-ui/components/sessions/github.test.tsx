import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Markdown } from '@/components/ui/markdown';
import type { GatewayApi, GitHubIssue, GitHubLinkSummary, GitHubPull } from '@/lib/api';
import { useCrew } from '@/lib/stores/crew';
import { GitHubDrawer, GitHubLinks } from './github';
import { ChatMessage } from './message';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const head = 'a'.repeat(40);
const pullUrl = 'https://github.com/octo-example/site/pull/7';
const issueUrl = 'https://github.com/octo-example/site/issues/12';

const pull: GitHubPull = {
  owner: 'octo-example',
  repo: 'site',
  number: 7,
  url: pullUrl,
  title: 'Add the pricing page',
  state: 'open',
  draft: false,
  author: { login: 'river-example' },
  base: { ref: 'main', sha: 'b'.repeat(40) },
  head: { ref: 'pricing-page', sha: head },
  body: 'Adds the **pricing** page.',
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  additions: 2,
  deletions: 1,
  changedFiles: 1,
  mergeable: 'clean',
  mergeMethods: ['squash', 'rebase'],
  reviews: {
    approved: 1,
    changesRequested: 0,
    commented: 0,
    latest: [{ reviewer: { login: 'sky-example' }, state: 'approved' }],
  },
  checks: {
    summary: { passing: 1, failing: 1, pending: 0 },
    runs: [
      {
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        startedAt: '2026-10-29T09:00:00.000Z',
        completedAt: '2026-10-29T09:03:12.000Z',
      },
      { name: 'lint', status: 'completed', conclusion: 'failure' },
    ],
  },
  files: [
    {
      path: 'app/pricing.tsx',
      status: 'modified',
      additions: 1,
      deletions: 1,
      diff: {
        path: 'app/pricing.tsx',
        additions: 1,
        deletions: 1,
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { kind: 'del', old: 1, text: 'return null;' },
              { kind: 'add', new: 1, text: 'return <Plans />;' },
            ],
          },
        ],
      },
    },
  ],
};

const issue: GitHubIssue = {
  owner: 'octo-example',
  repo: 'site',
  number: 12,
  kind: 'issue',
  url: issueUrl,
  title: 'Pricing page is blank on Safari',
  state: 'open',
  author: { login: 'sky-example' },
  labels: [{ name: 'bug', color: 'd73a4a' }],
  assignees: [{ login: 'river-example' }],
  body: 'It renders nothing.',
  comments: [
    { author: { login: 'lee-example' }, body: 'Seen on 18.2 too.', createdAt: pull.createdAt },
  ],
  createdAt: pull.createdAt,
  updatedAt: pull.updatedAt,
};

const summaries: Record<string, GitHubLinkSummary> = {
  [pullUrl]: {
    url: pullUrl,
    reachable: true,
    kind: 'pull',
    owner: 'octo-example',
    repo: 'site',
    number: 7,
    title: pull.title,
    state: 'open',
    draft: false,
    checks: { passing: 1, failing: 1, pending: 0 },
    mergeable: 'clean',
  },
  [issueUrl]: {
    url: issueUrl,
    reachable: true,
    kind: 'issue',
    owner: 'octo-example',
    repo: 'site',
    number: 12,
    title: issue.title,
    state: 'open',
  },
};

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  useCrew.getState().close();
});

function fakeApi(overrides: Partial<GitHubPull> = {}) {
  return {
    resolveGithubLinks: vi.fn(async (urls: string[]) =>
      urls.map((url) => summaries[url] ?? { url, reachable: false as const }),
    ),
    githubPull: vi.fn(async () => ({ ...pull, ...overrides })),
    githubIssue: vi.fn(async () => issue),
    mergeGithubPull: vi.fn(async () => ({
      merged: true as const,
      sha: 'c'.repeat(40),
      message: 'Merged',
    })),
  };
}

async function render(
  children: ReactNode,
  api: ReturnType<typeof fakeApi>,
  send?: (text: string) => Promise<unknown>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubLinks api={api as unknown as GatewayApi}>
          {children}
          <GitHubDrawer api={api as unknown as GatewayApi} profileId="profile" send={send} />
        </GitHubLinks>
      </QueryClientProvider>,
    ),
  );
  // The batch goes out on the next tick, and its answer comes back after.
  await settled(() => !element.querySelector('a[href*="github.com/octo-example"]'));
}

/** Waits for what a query brings, on a busy machine as on a quiet one. */
async function settled(done: () => boolean) {
  for (let tries = 0; tries < 100 && !done(); tries += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

async function openCard() {
  await act(async () => element.querySelector<HTMLButtonElement>('.github-ref')?.click());
  await settled(() => Boolean(element.querySelector('.github-drawer-title')));
}

const button = (name: string) =>
  [...element.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);

it('shows a pull request link as a reference, and one the App cannot see as the plain link', async () => {
  const api = fakeApi();
  const hidden = 'https://github.com/someone-else/private/pull/3';

  await render(<Markdown text={`Opened ${pullUrl} and saw ${hidden}.`} />, api);

  // Both links went in one request.
  expect(api.resolveGithubLinks).toHaveBeenCalledTimes(1);
  const reference = element.querySelector('.github-ref');
  // In the text, its mark and number; where it is, what it is and how it stands, on hover.
  expect(reference?.textContent).toBe('#7');
  expect(reference?.getAttribute('data-state')).toBe('open');
  expect(reference?.getAttribute('title')).toBe(
    'octo-example/site #7 · Add the pricing page · Open',
  );
  expect(element.querySelector(`a[href="${hidden}"]`)?.textContent).toBe(hidden);
});

it('shows a card in what a person wrote too', async () => {
  await render(
    <ChatMessage
      message={{
        id: 'm',
        profileId: 'profile',
        sessionId: 'session',
        role: 'user',
        content: `Can you look at ${pullUrl}?`,
        createdAt: pull.createdAt,
      }}
      group={false}
      people={new Map()}
      opensRun={false}
    />,
    fakeApi(),
  );

  expect(element.querySelector('.github-ref')?.textContent).toBe('#7');
  expect(element.textContent).toContain('Can you look at');
});

it('opens the pull request in the drawer and merges with the chosen method and the head seen', async () => {
  const api = fakeApi();

  await render(
    <Markdown text={pullUrl} />,
    api,
    vi.fn(async () => ({})),
  );
  await openCard();

  const drawer = element.querySelector('.github-drawer');
  expect(drawer?.textContent).toContain('Add the pricing page');
  expect(drawer?.textContent).toContain('pricing-page');
  expect(drawer?.textContent).toContain('3m 12s');
  expect(drawer?.textContent).toContain('sky-example');
  expect(drawer?.querySelector('.code-diff-path')?.textContent).toBe('app/pricing.tsx');
  // Conflicts are not there, so neither is the button that fixes them.
  expect(button('Fix conflicts')).toBeUndefined();

  await act(async () => button('Squash and merge')?.click());
  expect(element.querySelector('dialog')?.textContent).toContain('pricing-page lands on main');
  expect(api.mergeGithubPull).not.toHaveBeenCalled();

  const confirm = [...(element.querySelector('dialog')?.querySelectorAll('button') ?? [])].find(
    (item) => item.textContent === 'Squash and merge',
  );
  await act(async () => confirm?.click());
  expect(api.mergeGithubPull).toHaveBeenCalledWith('octo-example', 'site', 7, {
    method: 'squash',
    expectedHeadSha: head,
    profileId: 'profile',
  });

  // Merged in the drawer and in the text at once, though GitHub's reads here still say open.
  expect(element.querySelector('.github-drawer .github-state')?.textContent).toBe('Merged');
  expect(element.querySelector('.github-ref')?.getAttribute('data-state')).toBe('merged');
  expect(button('Squash and merge')).toBeUndefined();
});

it('keeps the drawer’s shape while GitHub answers', async () => {
  const api = fakeApi();
  let answer!: () => void;
  api.githubPull.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = () => resolve(pull);
      }),
  );

  await render(<Markdown text={pullUrl} />, api);
  await act(async () => element.querySelector<HTMLButtonElement>('.github-ref')?.click());

  expect(element.querySelector('.github-skeleton[role="status"]')).not.toBeNull();
  await act(async () => answer());
  await settled(() => Boolean(element.querySelector('.github-drawer-title')));
  expect(element.querySelector('.github-skeleton')).toBeNull();
});

it('offers to fix conflicts, asking the agent in this conversation', async () => {
  const send = vi.fn(async () => ({}));

  await render(<Markdown text={pullUrl} />, fakeApi({ mergeable: 'conflicts' }), send);
  await openCard();

  expect(element.textContent).toContain('This branch has conflicts');
  await act(async () => button('Fix conflicts')?.click());
  expect(send).toHaveBeenCalledWith(`Resolve the merge conflicts in ${pullUrl} and push the fix.`);
  // Sent, the drawer gives the conversation back.
  expect(element.querySelector('.github-drawer')).toBeNull();
});

it('only reads in a conversation answered in a messaging app', async () => {
  await render(<Markdown text={pullUrl} />, fakeApi({ mergeable: 'conflicts' }));
  await openCard();

  expect(element.querySelector('.github-drawer')?.textContent).toContain('Add the pricing page');
  expect(button('Squash and merge')).toBeUndefined();
  expect(button('Fix conflicts')).toBeUndefined();
  expect(element.querySelector(`.github-drawer a[href="${pullUrl}"]`)).not.toBeNull();
});

it('opens an issue with its labels, assignees and comments', async () => {
  await render(
    <Markdown text={issueUrl} />,
    fakeApi(),
    vi.fn(async () => ({})),
  );
  await openCard();

  const drawer = element.querySelector('.github-drawer');
  expect(drawer?.querySelector('.github-labels')?.textContent).toBe('bug');
  expect(drawer?.textContent).toContain('river-example');
  expect(drawer?.querySelector('.github-comments')?.textContent).toContain('Seen on 18.2 too.');
  expect(button('Squash and merge')).toBeUndefined();
});

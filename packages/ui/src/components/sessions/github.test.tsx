import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi, GitHubIssue, GitHubLinkSummary, GitHubPull } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { Markdown } from '../ui/markdown';
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
    latest: [
      {
        reviewer: { login: 'sky-example' },
        state: 'approved',
        submittedAt: '2026-10-29T11:00:00.000Z',
        url: `${pullUrl}#pullrequestreview-81`,
      },
    ],
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
  options: {
    merges?: boolean;
    fixConflicts?: (pull: { owner: string; repo: string; number: number }) => Promise<unknown>;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GitHubLinks api={api as unknown as GatewayApi}>
          {children}
          <GitHubDrawer
            api={api as unknown as GatewayApi}
            profileId="profile"
            merges={options.merges}
            fixConflicts={options.fixConflicts}
          />
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

/** The Inspector, named by the item it follows. */
const drawer = () => element.querySelector('aside');
const title = () => drawer()?.querySelector('h2');

async function openCard() {
  await act(async () => element.querySelector<HTMLButtonElement>('.github-ref')?.click());
  await settled(() => Boolean(title()));
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

const section = (name: string) => element.querySelector(`section[aria-label="${name}"]`);
const heading = (name: string) => section(name)?.querySelector('button[aria-expanded]');
/** The merge confirmation, drawn over the page rather than inside the drawer. */
const dialog = () => document.querySelector('[role="dialog"]');

it('opens the pull request in folding sections, and merges with the chosen method and the head seen', async () => {
  const api = fakeApi();

  await render(<Markdown text={pullUrl} />, api, { merges: true, fixConflicts: vi.fn() });
  await openCard();

  expect(drawer()?.getAttribute('aria-label')).toBe('octo-example/site #7');
  expect(title()?.textContent).toBe('Add the pricing page');
  expect(drawer()?.textContent).toContain('pricing-page');
  // The author is a link to their profile, and the pull request opens on GitHub from the top.
  expect(drawer()?.querySelector('a[href="https://github.com/river-example"]')?.textContent).toBe(
    'river-example',
  );
  expect(drawer()?.querySelector(`a[href="${pullUrl}"]`)?.textContent).toBe('octo-example/site #7');
  // Its close is at hand, and the keyboard is on it; reading again is among its options.
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
  expect(drawer()?.querySelector('[aria-label="Refresh"]')).toBeNull();

  // Every part in one view, each saying what it holds while folded.
  expect(section('Description')?.textContent).toContain('pricing page.');
  expect(heading('Checks')?.textContent).toBe('Checks1/2');
  expect(section('Checks')?.textContent).toContain('3m 12s');
  expect(heading('Changes')?.textContent).toBe('Changes1 file');
  expect(section('Changes')?.querySelector('.code-diff-path')?.textContent).toBe('app/pricing.tsx');
  // A review opens where it was written.
  const review = section('Reviews')?.querySelector('a');
  expect(review?.getAttribute('href')).toBe(`${pullUrl}#pullrequestreview-81`);
  expect(review?.textContent).toContain('sky-example');
  expect(review?.textContent).toContain('Approved');

  await act(async () => (heading('Checks') as HTMLButtonElement | null)?.click());
  expect(heading('Checks')?.getAttribute('aria-expanded')).toBe('false');

  // Mergeable, so merging is offered and fixing conflicts is not.
  expect(button('Fix merge conflicts')).toBeUndefined();
  await act(async () => button('Squash and merge')?.click());
  expect(dialog()?.textContent).toContain('pricing-page lands on main');
  expect(api.mergeGithubPull).not.toHaveBeenCalled();

  const confirm = [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (item) => item.textContent === 'Squash and merge',
  );
  await act(async () => confirm?.click());
  expect(api.mergeGithubPull).toHaveBeenCalledWith('octo-example', 'site', 7, {
    method: 'squash',
    expectedHeadSha: head,
    profileId: 'profile',
  });

  // Merged in the drawer and in the text without reading GitHub again, whose reads here still
  // say open. The text follows the drawer's copy as the cache tells its readers.
  expect(drawer()?.querySelector('header')?.textContent).toContain('Merged');
  await settled(
    () => element.querySelector('.github-ref')?.getAttribute('data-state') === 'merged',
  );
  expect(element.querySelector('.github-ref')?.getAttribute('data-state')).toBe('merged');
  expect(api.githubPull).toHaveBeenCalledTimes(1);
});

it('says why GitHub could not be read, and reads it again on asking', async () => {
  const api = fakeApi();
  api.githubPull.mockImplementationOnce(async () => {
    throw new Error('GitHub did not answer in time.');
  });

  await render(<Markdown text={pullUrl} />, api);
  await act(async () => element.querySelector<HTMLButtonElement>('.github-ref')?.click());
  await settled(() => Boolean(button('Try again')));
  expect(drawer()?.textContent).toContain('GitHub did not answer in time.');

  await act(async () => button('Try again')?.click());
  await settled(() => Boolean(title()));
  expect(title()?.textContent).toBe('Add the pricing page');
});

it('puts the drawer away on Escape', async () => {
  await render(<Markdown text={pullUrl} />, fakeApi());
  await openCard();

  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(drawer()).toBeNull();
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

  expect(drawer()?.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => answer());
  await settled(() => Boolean(title()));
  expect(drawer()?.querySelector('[role="status"]')).toBeNull();
});

it('offers to fix conflicts in the place of merging and of the line about them', async () => {
  const fixConflicts = vi.fn(async () => ({}));

  await render(<Markdown text={pullUrl} />, fakeApi({ mergeable: 'conflicts' }), {
    merges: true,
    fixConflicts,
  });
  await openCard();

  expect(element.textContent).not.toContain('This branch has conflicts');
  expect(button('Squash and merge')).toBeUndefined();
  await act(async () => button('Fix merge conflicts')?.click());
  expect(fixConflicts).toHaveBeenCalledWith(
    expect.objectContaining({ owner: 'octo-example', repo: 'site', number: 7 }),
  );
  // The drawer stays open on the pull request while the agent works.
  expect(drawer()).not.toBeNull();
});

it('fixes conflicts in a conversation answered in a messaging app', async () => {
  await render(<Markdown text={pullUrl} />, fakeApi({ mergeable: 'conflicts' }), {
    fixConflicts: vi.fn(async () => ({})),
  });
  await openCard();

  expect(button('Fix merge conflicts')).not.toBeUndefined();
});

it('does not merge in a conversation answered in a messaging app', async () => {
  await render(<Markdown text={pullUrl} />, fakeApi(), { fixConflicts: vi.fn(async () => ({})) });
  await openCard();

  expect(button('Squash and merge')).toBeUndefined();
  expect(element.textContent).toContain('Ready to merge.');
});

it('opens an issue with its labels, assignees and comments', async () => {
  await render(<Markdown text={issueUrl} />, fakeApi(), { fixConflicts: vi.fn(async () => ({})) });
  await openCard();

  expect(drawer()?.querySelector('[aria-label="Labels"]')?.textContent).toBe('bug');
  expect(drawer()?.textContent).toContain('river-example');
  expect(drawer()?.querySelector('[aria-label="Comments"]')?.textContent).toContain(
    'Seen on 18.2 too.',
  );
  expect(button('Squash and merge')).toBeUndefined();
});

it('folds every part and diff at once from its options, and opens them again', async () => {
  await render(<Markdown text={pullUrl} />, fakeApi());
  await openCard();
  const expanded = () =>
    [...(drawer()?.querySelectorAll('section button[aria-expanded]') ?? [])].map((item) =>
      item.getAttribute('aria-expanded'),
    );
  const entry = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === name,
    );

  await act(async () =>
    drawer()?.querySelector<HTMLButtonElement>('[aria-label="Options"]')?.click(),
  );
  await act(async () => entry('Collapse all')?.click());
  expect(expanded().every((state) => state === 'false')).toBe(true);

  await act(async () =>
    drawer()?.querySelector<HTMLButtonElement>('[aria-label="Options"]')?.click(),
  );
  await act(async () => entry('Expand all')?.click());
  expect(expanded().every((state) => state === 'true')).toBe(true);
});

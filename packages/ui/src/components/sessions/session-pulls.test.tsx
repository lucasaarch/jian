// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GitHubLinkSummary } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { SessionPulls } from './session-pulls';

const pr = (number: number) => `https://github.com/acme/harbor/pull/${number}`;

const summary = (
  number: number,
  extra: Partial<Extract<GitHubLinkSummary, { reachable: true }>> = {},
): GitHubLinkSummary => ({
  url: pr(number),
  reachable: true,
  kind: 'pull',
  owner: 'acme',
  repo: 'harbor',
  number,
  title: `Change ${number}`,
  state: 'open',
  ...extra,
});

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
  document.body.innerHTML = '';
});

const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

const show = async (urls: string[] | Error, summaries: GitHubLinkSummary[] = []) => {
  const resolveGithubLinks = vi.fn(async (asked: string[]) =>
    asked.map(
      (url) =>
        summaries.find((item) => item.url === url) ??
        ({ url, reachable: false } as GitHubLinkSummary),
    ),
  );
  const api = {
    sessionPulls: async () => {
      if (urls instanceof Error) throw urls;
      return urls.map((url) => ({ url }));
    },
    resolveGithubLinks,
  };
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SessionPulls api={api} profileId="profile" sessionId="session" />
      </QueryClientProvider>,
    ),
  );
  await tick();
  return resolveGithubLinks;
};

const trigger = () => element.querySelector<HTMLElement>('.session-badge-trigger');
const open = async () => {
  await act(async () => trigger()?.click());
  await tick();
};
const rows = () => [...document.querySelectorAll('.session-pull')];

it('shows nothing when the agent sent none', async () => {
  await show([]);

  expect(trigger()).toBeNull();
});

it('shows nothing when they could not be read, as on a gateway without the route', async () => {
  await show(new Error('Not found'));

  expect(trigger()).toBeNull();
});

it('says how many, in the singular too', async () => {
  await show([pr(1), pr(2), pr(3)]);
  expect(trigger()?.textContent).toBe('3 PRs');

  await act(async () => root.unmount());
  root = createRoot(element);
  await show([pr(1)]);
  expect(trigger()?.textContent).toBe('1 PR');
});

it('asks GitHub nothing until the list is opened', async () => {
  const resolve = await show([pr(1)], [summary(1)]);
  expect(resolve).not.toHaveBeenCalled();

  await open();

  expect(resolve).toHaveBeenCalledTimes(1);
});

it('lists them in the order sent, with what each is and how it stands', async () => {
  await show(
    [pr(4), pr(3), pr(2), pr(1)],
    [
      summary(4, { checks: { passing: 3, failing: 1, pending: 0 } }),
      summary(3, { draft: true, checks: { passing: 0, failing: 0, pending: 2 } }),
      summary(2, { mergeable: 'conflicts' }),
      summary(1, { state: 'merged', checks: { passing: 0, failing: 2, pending: 0 } }),
    ],
  );

  await open();

  const text = rows().map((row) => row.textContent);
  expect(text[0]).toContain('Change 4');
  expect(text[0]).toContain('#4');
  expect(text[0]).toContain('harbor');
  expect(text[0]).toContain('Open · Checks failing');
  expect(text[1]).toContain('Draft · Checks pending');
  expect(text[2]).toContain('Open · Conflicts');
  // What is finished says only that: its old checks no longer matter.
  expect(text[3]).toContain('Merged');
  expect(text[3]).not.toContain('Checks');
});

it('opens one in the inspector, and closes the list', async () => {
  useCrew.getState().show('session', []);
  await show([pr(1)], [summary(1)]);
  await open();

  await act(async () => document.querySelector<HTMLElement>('.session-pull')?.click());
  await tick();

  expect(useCrew.getState().following).toContain('harbor');
  expect(document.querySelector('.session-pull')).toBeNull();
});

it('keeps one GitHub cannot show on the list, with the way to it', async () => {
  await show([pr(9)]);

  await open();

  const row = rows()[0];
  expect(row?.textContent).toContain('Status unavailable');
  expect(row?.textContent).toContain('#9');
  expect(row?.getAttribute('href')).toBe(pr(9));
  expect(trigger()?.textContent).toBe('1 PR');
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Project } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { ProjectSelect } from './project-select';

const account = '6d1f2c3a-1111-4111-8111-111111111111';
const repository = (id: number, fullName: string, isPrivate: boolean) => ({
  id,
  name: fullName.split('/')[1] ?? fullName,
  fullName,
  ownerLogin: fullName.split('/')[0] ?? fullName,
  private: isPrivate,
  htmlUrl: `https://github.com/${fullName}`,
  cloneUrl: `https://github.com/${fullName}.git`,
  accountId: account,
});
const project = (id: string, repositoryUrl: string, githubRepositoryId?: number): Project => ({
  id,
  profileId: 'mia',
  name: repositoryUrl,
  repositoryUrl,
  ...(githubRepositoryId ? { githubAccountId: account, githubRepositoryId } : {}),
  createdAt: '2026-10-29T12:00:00Z',
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The select over a cache that already holds what GitHub answered, as the composer finds it. */
async function render({
  projects = [],
  projectId = null,
  accounts = 1,
}: {
  projects?: Project[];
  projectId?: string | null;
  accounts?: number;
} = {}) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(
    keys.githubRepositories,
    accounts
      ? [repository(42, 'octo-example/site', false), repository(7, 'octo-example/notes', true)]
      : [],
  );
  cache.setQueryData(keys.githubIntegration, {
    configured: true,
    accounts: Array.from({ length: accounts }, () => ({ id: account })),
  });
  const opened = project('opened', 'https://github.com/octo-example/notes.git', 7);
  const ensureProject = vi.fn(async () => opened);
  const onChange = vi.fn();

  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(ProjectSelect, {
          api: { ensureProject } as unknown as GatewayApi,
          profileId: 'mia',
          projects,
          projectId,
          onChange,
        }),
      ),
    );
  });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Project"]')?.click(),
  );

  return {
    ensureProject,
    onChange,
    trigger: () => container.querySelector('[aria-label="Project"]')?.textContent,
    options: () => [...document.querySelectorAll<HTMLElement>('[role="option"]')],
  };
}

it('lists every connected repository by its slug', async () => {
  const view = await render();

  expect(view.options().map((option) => option.textContent)).toEqual([
    'No project',
    'octo-example/site',
    'octo-example/notes',
  ]);
});

it('opens the repository as this agent’s project and chooses that project', async () => {
  const view = await render();

  await act(async () => view.options()[2]?.click());

  expect(view.ensureProject).toHaveBeenCalledWith('mia', {
    githubAccountId: account,
    githubRepositoryId: 7,
  });
  expect(view.onChange).toHaveBeenCalledWith('opened');
});

it('shows a chat’s project even when its repository is not in the list', async () => {
  const older = project('older', 'git@github.com:example/legacy.git');
  const view = await render({ projects: [older], projectId: 'older' });

  expect(view.trigger()).toContain('example/legacy');
  expect(view.options().map((option) => option.textContent)).toContain('example/legacy');
});

it('points to Integrations when no GitHub account is connected', async () => {
  await render({ accounts: 0 });

  const link = document.querySelector<HTMLAnchorElement>('.select-footer a');
  expect(link?.textContent).toContain('Connect GitHub');
  expect(link?.getAttribute('href')).toBe('/settings/integrations');
});

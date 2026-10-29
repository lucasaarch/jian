import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi } from '@/lib/api';
import { keys } from '@/lib/query/keys';
import { NewProjectDialog } from './new-project';

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

const repository = (accountId: string, id: number, owner: string, name: string) => ({
  accountId,
  id,
  name,
  fullName: `${owner}/${name}`,
  ownerLogin: owner,
  private: true,
  htmlUrl: `https://github.com/${owner}/${name}`,
  cloneUrl: `https://github.com/${owner}/${name}.git`,
});

async function render(accounts: { id: string; login: string }[]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const cache = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  cache.setQueryData(keys.githubIntegration, { configured: true, accounts });
  cache.setQueryData(keys.githubRepositories, [
    repository('mona-account', 7, 'mona', 'notes'),
    repository('org-account', 42, 'octo-example', 'site'),
  ]);
  const project = {
    id: 'new',
    name: 'site',
    repositoryUrl: 'https://github.com/octo-example/site.git',
  };
  const createProject = vi.fn(async () => project);
  const created = vi.fn();
  const close = vi.fn();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <NewProjectDialog
          api={{ createProject } as unknown as GatewayApi}
          profileId="mia"
          close={close}
          created={created}
        />
      </QueryClientProvider>,
    ),
  );
  return { createProject, created, close, project };
}

it('creates a project from one list of every account repository, named owner/repo', async () => {
  const { createProject, created, close, project } = await render([
    { id: 'mona-account', login: 'mona' },
    { id: 'org-account', login: 'octo-example' },
  ]);

  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Repository"]')?.click(),
  );
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((option) => option.textContent)).toEqual([
    'mona/notesPrivate',
    'octo-example/sitePrivate',
  ]);
  await act(async () => options[1]?.click());

  // The name follows the repository while it is still empty.
  expect(document.querySelector<HTMLInputElement>('input[placeholder="My project"]')?.value).toBe(
    'site',
  );
  await act(async () => {
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  expect(createProject).toHaveBeenCalledWith('mia', {
    name: 'site',
    githubAccountId: 'org-account',
    githubRepositoryId: 42,
  });
  expect(created).toHaveBeenCalledWith(project);
  expect(close).toHaveBeenCalled();
});

it('sends the owner to Integrations when no GitHub account is connected', async () => {
  await render([]);

  expect(document.body.textContent).toContain('Connect a GitHub account under Integrations');
  expect(document.querySelector('a')?.getAttribute('href')).toBe('/settings/integrations');
  expect(document.querySelector('[aria-label="Repository"]')).toBeNull();
});

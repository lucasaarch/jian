import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { Project, Run, Session } from '../lib/api';
import { useLayout } from '../lib/stores/layout';
import { memoryNavigation } from '../platform/navigation';
import { AgentCache } from '../test/agent';
import { profile } from '../test/fixtures';
import { ChatSidebar } from './chat-sidebar';

const project = {
  id: '00000000-0000-4000-8000-0000000000a1',
  profileId: profile.id,
  name: 'atlas/harbor',
  repositoryUrl: 'https://example.test/atlas/harbor.git',
  createdAt: '2026-10-01T00:00:00Z',
} as Project;

const chat = (id: string, title: string, projectId?: string) =>
  ({
    id,
    profileId: profile.id,
    title,
    channel: 'gateway',
    protection: 'ask',
    createdAt: '2026-10-20T00:00:00Z',
    ...(projectId ? { projectId } : {}),
  }) as Session;

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  useLayout.setState({ chatList: false, closedSections: [] });
  window.localStorage.clear();
});

async function render(activities: Run[] = []) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache
        profile={profile}
        slices={{
          sessions: [chat('s-1', 'Release notes', project.id), chat('s-2', 'Groceries')],
          projects: [project],
          channels: [],
          contacts: [],
          activities,
        }}
      >
        <ChatSidebar profileId={profile.id} />
      </AgentCache>,
    ),
  );
  const heading = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(
      (button) => button.textContent === name,
    );
  const chats = () =>
    // A folded list stays in place for its motion, out of reach.
    [...host.querySelectorAll('li > button:first-child')]
      .filter((button) => !button.closest('[inert]'))
      .map((button) => button.textContent)
      .filter((text) => text && !text.startsWith('Show'));
  return { host, heading, chats };
}

it('lists the projects as folders and the loose chats under their own heading', async () => {
  const view = await render();

  expect(view.heading('Projects')).toBeDefined();
  expect(view.heading('atlas/harbor')).toBeDefined();
  expect(view.heading('Conversations')).toBeDefined();
  expect(view.chats()).toEqual(['Release notes', 'Groceries']);
});

it('folds a project and remembers it', async () => {
  const view = await render();

  await act(async () => view.heading('atlas/harbor')?.click());

  expect(view.chats()).toEqual(['Groceries']);
  expect(JSON.parse(window.localStorage.getItem('jian-layout') ?? '{}').closedSections).toEqual([
    `project:${project.id}`,
  ]);
});

it('opens a chat in the address', async () => {
  const view = await render();
  const row = [...view.host.querySelectorAll<HTMLButtonElement>('li button')].find(
    (button) => button.textContent === 'Groceries',
  );

  await act(async () => row?.click());

  expect(memoryNavigation.current()).toBe(`/agents/${profile.id}/sessions/s-2`);
});

it('shows worker activity on the principal conversation instead of its hidden task session', async () => {
  const view = await render([
    { id: 'parent', sessionId: 's-1', status: 'completed' },
    {
      id: 'child',
      sessionId: 'private-task',
      status: 'running',
      subagent: { parentRunId: 'parent' },
    },
  ] as Run[]);
  const row = [...view.host.querySelectorAll('li')].find((item) =>
    item.textContent?.includes('Release notes'),
  );
  expect(row?.querySelector('[aria-label="Working"]')).not.toBeNull();
  expect(row?.querySelector('time')).toBeNull();
});

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProfileArtifact, Session } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { useCrew } from '../../lib/stores/crew';
import { memoryNavigation } from '../../platform/navigation';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { ArtifactsScreen } from './artifacts-screen';
import type { ArtifactsPageApi } from './use-profile-artifacts';

const at = '2026-11-18T10:00:00.000Z';
const chat = {
  id: 's-1',
  profileId: profile.id,
  title: 'Launch plan',
  channel: 'gateway',
  protection: 'ask',
  createdAt: at,
} as Session;
const landing: ProfileArtifact = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: chat.id,
  sessionTitle: chat.title ?? null,
  title: 'Landing',
  type: 'html',
  visibility: 'public',
  version: 2,
  publicPath: `/v1/public-artifacts/${'A'.repeat(43)}`,
  createdAt: at,
  updatedAt: at,
};
// Made in a conversation the sidebar's list does not hold: it goes by the title the gateway sent.
const notes: ProfileArtifact = {
  ...landing,
  id: '22222222-2222-4222-8222-222222222222',
  sessionId: 's-9',
  sessionTitle: 'Old notes',
  title: 'Release notes',
  type: 'markdown',
  visibility: 'private',
  version: 1,
  publicPath: null,
};
const diagram: ProfileArtifact = {
  ...notes,
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Flow',
  type: 'mermaid',
};

/** A gateway holding these, answering two to a page as the real one answers thirty. */
function gateway(artifacts: ProfileArtifact[] = [landing, notes, diagram]) {
  const held = [...artifacts];
  const refused = vi.fn(async (): Promise<never> => {
    throw new Error('Not asked for here');
  });

  return {
    held,
    media: refused,
    sessionArtifacts: refused,
    exportSessionArtifact: refused,
    setSessionArtifactVisibility: refused,
    editSessionArtifact: refused,
    sessionArtifactVersion: vi.fn(
      async (_profile: string, _session: string, artifactId: string, version: number) => ({
        artifactId,
        version,
        author: 'agent' as const,
        content: '<!doctype html><html><body><h1>Launch</h1></body></html>',
        createdAt: at,
      }),
    ),
    profileArtifacts: vi.fn(
      async (_profile: string, wanted: { q?: string; type?: string; before?: string } = {}) => {
        const found = held.filter(
          (item) =>
            (!wanted.q || item.title.toLowerCase().includes(wanted.q.toLowerCase())) &&
            (!wanted.type || item.type === wanted.type),
        );
        const from = wanted.before ? found.findIndex((item) => item.id === wanted.before) + 1 : 0;
        const items = found.slice(from, from + 2);
        const last = items.at(-1);

        return {
          items,
          nextCursor: last && found.indexOf(last) < found.length - 1 ? last.id : null,
        };
      },
    ),
    deleteSessionArtifact: vi.fn(async (_profile: string, _session: string, artifactId: string) => {
      held.splice(
        held.findIndex((item) => item.id === artifactId),
        1,
      );
      return null;
    }),
  } satisfies ArtifactsPageApi & { held: ProfileArtifact[] };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function settled(done: () => boolean, limit = 100) {
  for (let tries = 0; tries < limit && !done(); tries += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

const titles = () =>
  [...container.querySelectorAll('ul[aria-label="Artifacts"] > li > button:first-child')].map(
    (row) => row.getAttribute('aria-label')?.replace(/^Open /, ''),
  );
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent === label,
  );
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | undefined)?.click());
const entries = () => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
const entry = async (artifact: ProfileArtifact, name: string) => {
  await settled(() => entries().length === 0);
  await click(button(`Actions for ${artifact.title}`));
  await settled(() => entries().length > 0);
  await click(entries().find((item) => item.textContent === name));
};

async function render(api: ArtifactsPageApi, mode: 'server' | 'local' = 'server') {
  const client = agentClient({
    profile,
    slices: { sessions: [chat], projects: [], contacts: [] },
  });
  client.setQueryData(keys.gateway, { status: 'ok', mode });
  await act(async () =>
    root.render(
      <AgentCache profile={profile} client={client}>
        <ArtifactsScreen profileId={profile.id} api={api} />
      </AgentCache>,
    ),
  );
  await settled(() => titles().length > 0);
}

it('lists what the agent made in every conversation, a page at a time', async () => {
  const api = gateway();
  await render(api);

  expect(titles()).toEqual(['Landing', 'Release notes']);
  const [first, second] = [...container.querySelectorAll('ul[aria-label="Artifacts"] > li')];
  // The conversation by the name the sidebar gives it, or by the title the gateway sent.
  expect(first?.textContent).toContain('Web page · Version 2 · Launch plan');
  expect(first?.textContent).toContain('Public');
  expect(second?.textContent).toContain('Document · Version 1 · Old notes');
  expect(second?.textContent).not.toContain('Public');

  await click(button('Load more'));
  await settled(() => titles().length === 3);
  expect(titles()).toEqual(['Landing', 'Release notes', 'Flow']);
  expect(api.profileArtifacts).toHaveBeenLastCalledWith(profile.id, { before: notes.id });
  expect(button('Load more')).toBeUndefined();
});

it('narrows the list by title, asking the gateway once typing rests', async () => {
  const api = gateway();
  await render(api);
  const search = container.querySelector<HTMLInputElement>('input[type=search]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  await act(async () => {
    set?.call(search, 'flow');
    search?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settled(() => titles().length === 1);

  expect(titles()).toEqual(['Flow']);
  expect(api.profileArtifacts).toHaveBeenLastCalledWith(profile.id, { q: 'flow' });
});

it('offers to change who reads one only on a server gateway', async () => {
  await render(gateway(), 'local');

  expect(button('Public: anyone with the link')).toBeUndefined();
  expect(button('Private: only you')).toBeUndefined();
  expect(button(`Actions for ${landing.title}`)).toBeDefined();
});

it('opens one in the page with the Inspector’s own view, and comes back to the list', async () => {
  const api = gateway();
  await render(api);

  await click(button('Open Landing'));
  await settled(() => Boolean(container.querySelector('iframe')));

  expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('Landing');
  expect(api.sessionArtifactVersion).toHaveBeenCalledWith(profile.id, chat.id, landing.id, 2);
  // No Inspector here to put away.
  expect(button('Close', container)).toBeUndefined();

  await click(button('All artifacts', container));
  expect(titles()).toEqual(['Landing', 'Release notes']);
});

it('opens a page already being edited, and offers no edit of what cannot be', async () => {
  await render(gateway());

  await click(button(`Actions for ${notes.title}`));
  await settled(() => entries().length > 0);
  expect(entries().map((item) => item.textContent)).toEqual([
    'Open',
    'Go to conversation',
    'Delete',
  ]);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );

  await entry(landing, 'Edit');
  await settled(() => Boolean(button('Save', container)));
  expect(button('Save', container)).toBeDefined();
  expect(button('Cancel', container)).toBeDefined();
});

it('goes to the conversation with the Artifact open in its Inspector', async () => {
  await render(gateway());

  await entry(landing, 'Go to conversation');

  expect(memoryNavigation.current()).toBe(`/agents/${profile.id}/sessions/${chat.id}`);
  // What the conversation restores on arriving.
  await act(async () => useCrew.getState().show(chat.id, []));
  const crew = useCrew.getState();
  expect(crew.opened).toBe(true);
  expect(crew.tabs.find((tab) => tab.key === crew.following)).toMatchObject({
    kind: 'artifacts',
    sessionId: chat.id,
    artifactId: landing.id,
  });
  await act(async () => {
    useCrew.setState({ tabs: [], opened: false, following: undefined });
    useCrew.getState().leave(chat.id);
  });
});

it('deletes one only after asking', async () => {
  const api = gateway();
  await render(api);

  await entry(landing, 'Delete');
  await settled(() => Boolean(document.querySelector('[role=dialog]')));
  const dialog = document.querySelector('[role=dialog]') as HTMLElement;
  expect(dialog.textContent).toContain('Delete Landing?');
  expect(dialog.textContent).toContain('its public link stops working');
  expect(api.deleteSessionArtifact).not.toHaveBeenCalled();

  await click(button('Delete Artifact', dialog));
  await settled(() => !titles().includes('Landing'));

  expect(api.deleteSessionArtifact).toHaveBeenCalledWith(profile.id, chat.id, landing.id);
  expect(titles()).toEqual(['Release notes', 'Flow']);
});

it('says so when the gateway refuses to delete, and keeps the Artifact', async () => {
  const api = gateway();
  api.deleteSessionArtifact.mockRejectedValueOnce(
    new Error('A paired device cannot delete an Artifact.'),
  );
  await render(api);

  await entry(notes, 'Delete');
  await settled(() => Boolean(document.querySelector('[role=dialog]')));
  await click(button('Delete Artifact', document.querySelector('[role=dialog]') as HTMLElement));
  await settled(() => api.deleteSessionArtifact.mock.calls.length > 0);

  expect(titles()).toEqual(['Landing', 'Release notes']);
});

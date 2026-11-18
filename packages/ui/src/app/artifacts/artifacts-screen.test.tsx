import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ArtifactFolder, ProfileArtifact, Project, Session } from '../../lib/api';
import { artifactsPath } from '../../lib/navigation';
import { keys } from '../../lib/query/keys';
import { useCrew } from '../../lib/stores/crew';
import { draftKey, useDrafts } from '../../lib/stores/drafts';
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
const site = { id: '44444444-4444-4444-8444-444444444444', name: 'Site' } as Project;
const landing: ProfileArtifact = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: chat.id,
  sessionTitle: chat.title ?? null,
  projectId: site.id,
  pinned: false,
  folderId: null,
  title: 'Landing',
  type: 'html',
  visibility: 'public',
  version: 2,
  publicPath: `/v1/public-artifacts/${'A'.repeat(43)}`,
  createdAt: at,
  updatedAt: at,
};
const notes: ProfileArtifact = {
  ...landing,
  id: '22222222-2222-4222-8222-222222222222',
  sessionId: 's-9',
  sessionTitle: 'Old notes',
  projectId: null,
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
const keepers: ArtifactFolder = {
  id: '55555555-5555-4555-8555-555555555555',
  name: 'Keepers',
  artifacts: 0,
  createdAt: at,
};

type Wanted = NonNullable<Parameters<ArtifactsPageApi['profileArtifacts']>[1]>;

/**
 * A gateway holding these, answering two to a page as the real one answers thirty, and keeping
 * what it is asked to change as the real one does.
 */
function gateway(artifacts: ProfileArtifact[] = [landing, notes, diagram], made = [keepers]) {
  const held = artifacts.map((item) => ({ ...item }));
  const folders = made.map((folder) => ({ ...folder }));
  const one = (artifactId: string) =>
    held.find((item) => item.id === artifactId) as ProfileArtifact;
  const refused = vi.fn(async (): Promise<never> => {
    throw new Error('Not asked for here');
  });

  return {
    held,
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
        ...(one(artifactId).type === 'deck'
          ? { slides: ['<h1>First</h1>', '<h1>Second</h1>'] }
          : {}),
        createdAt: at,
      }),
    ),
    profileArtifacts: vi.fn(async (_profile: string, wanted: Wanted = {}) => {
      const found = held.filter(
        (item) =>
          (!wanted.q || item.title.toLowerCase().includes(wanted.q.toLowerCase())) &&
          (!wanted.type || item.type === wanted.type) &&
          (!wanted.folder || item.folderId === wanted.folder) &&
          (!wanted.project ||
            (item.folderId === null && (item.projectId ?? 'none') === wanted.project)) &&
          (!wanted.pinned || String(item.pinned) === wanted.pinned),
      );
      const from = wanted.before ? found.findIndex((item) => item.id === wanted.before) + 1 : 0;
      const items = found.slice(from, from + (wanted.limit ?? 2));
      const last = items.at(-1);

      return {
        items,
        nextCursor: last && found.indexOf(last) < found.length - 1 ? last.id : null,
      };
    }),
    artifactFolders: vi.fn(async () => {
      const started = held.filter((item) => item.folderId === null);

      return {
        folders: folders.map((folder) => ({
          ...folder,
          artifacts: held.filter((item) => item.folderId === folder.id).length,
        })),
        projects: [site.id, null]
          .map((projectId) => ({
            projectId,
            name: projectId ? site.name : null,
            artifacts: started.filter((item) => item.projectId === projectId).length,
          }))
          .filter((project) => project.artifacts > 0),
      };
    }),
    updateSessionArtifact: vi.fn(
      async (
        _profile: string,
        _session: string,
        artifactId: string,
        change: { title?: string; pinned?: boolean; folderId?: string | null },
      ) => Object.assign(one(artifactId), change),
    ),
    duplicateSessionArtifact: vi.fn(async (_profile: string, _session: string, id: string) => {
      const copy: ProfileArtifact = {
        ...one(id),
        id: '66666666-6666-4666-8666-666666666666',
        title: `${one(id).title} (copy)`,
        visibility: 'private',
        publicPath: null,
        pinned: false,
        version: 1,
      };
      held.unshift(copy);
      return copy;
    }),
    createArtifactFolder: vi.fn(async (_profile: string, name: string) => {
      const folder = {
        id: '77777777-7777-4777-8777-777777777777',
        name,
        artifacts: 0,
        createdAt: at,
      };
      folders.push(folder);
      return folder;
    }),
    renameArtifactFolder: vi.fn(async (_profile: string, folderId: string, name: string) =>
      Object.assign(folders.find((folder) => folder.id === folderId) as ArtifactFolder, { name }),
    ),
    deleteArtifactFolder: vi.fn(async (_profile: string, folderId: string) => {
      folders.splice(
        folders.findIndex((folder) => folder.id === folderId),
        1,
      );
      for (const item of held) if (item.folderId === folderId) item.folderId = null;
      return null;
    }),
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
  useDrafts.getState().forgetAll();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settled(done: () => boolean, limit = 100) {
  for (let tries = 0; tries < limit && !done(); tries += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

/** The names on the cards of one grid, in order: the pinned ones', or the rest's. */
const titles = (grid = 'Artifacts') =>
  [
    ...container.querySelectorAll(`ul[aria-label="${grid}"] > li > button[aria-label^="Open "]`),
  ].map((card) => card.getAttribute('aria-label')?.replace(/^Open /, ''));
const card = (artifact: ProfileArtifact) =>
  button(`Open ${artifact.title}`, container)?.closest('li') as HTMLElement;
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
const dialog = () => document.querySelector('[role=dialog]') as HTMLElement;
/** Types a name over the one in the open dialog, and saves it. */
const name = async (text: string) => {
  await settled(() => Boolean(dialog()?.querySelector('input')));
  const field = dialog().querySelector('input') as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  await act(async () => {
    set?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(button('Save', dialog()));
};
/** One of the places in the row of folders, by its name. */
const place = (label: string) =>
  [...container.querySelectorAll('[aria-label="Folder"] button')].find((item) =>
    item.textContent?.startsWith(label),
  );

async function render(api: ArtifactsPageApi, mode: 'server' | 'local' = 'server') {
  const client = agentClient({
    profile,
    slices: { sessions: [chat], projects: [site], contacts: [] },
  });
  client.setQueryData(keys.gateway, { status: 'ok', mode });
  // Where the page is, which the agent's cache alone leaves at the agent.
  memoryNavigation.go(artifactsPath(profile.id));
  await act(async () =>
    root.render(
      <AgentCache profile={profile} client={client}>
        <ArtifactsScreen profileId={profile.id} api={api} />
      </AgentCache>,
    ),
  );
  await settled(() => titles().length > 0);
}

it('shows what the agent made in every conversation as cards, a page at a time', async () => {
  const api = gateway();
  await render(api);

  expect(titles()).toEqual(['Landing', 'Release notes']);
  expect(card(landing).textContent).toContain('Web page · ');
  expect(card(landing).textContent).toContain('Public');
  expect(card(notes).textContent).toContain('Document · ');
  expect(card(notes).textContent).not.toContain('Public');
  // Neither is something cheap to draw: each is its kind's picture.
  expect(card(landing).querySelector('[data-thumbnail]')?.getAttribute('data-thumbnail')).toBe(
    'kind',
  );

  await click(button('Load more'));
  await settled(() => titles().length === 3);
  expect(titles()).toEqual(['Landing', 'Release notes', 'Flow']);
  expect(api.profileArtifacts).toHaveBeenLastCalledWith(profile.id, {
    pinned: 'false',
    before: notes.id,
  });
  expect(button('Load more')).toBeUndefined();
});

it('draws a deck’s first slide on its card once the card is near the screen', async () => {
  // The host tells at once that every box it is asked about is in view.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private seen: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.seen([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  const deck: ProfileArtifact = { ...notes, title: 'Pitch', type: 'deck' };
  const api = gateway([deck]);
  await render(api);
  await settled(() => Boolean(card(deck).querySelector('iframe')));

  expect(card(deck).querySelector('[data-thumbnail]')?.getAttribute('data-thumbnail')).toBe(
    'slide',
  );
  expect(card(deck).querySelector('iframe')?.title).toBe('Pitch, first slide');
  expect(api.sessionArtifactVersion).toHaveBeenCalledWith(profile.id, deck.sessionId, deck.id, 1);
});

it('narrows the cards by title, asking the gateway once typing rests', async () => {
  const api = gateway();
  await render(api);
  const search = container.querySelector<HTMLInputElement>('input[type=search]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  expect(container.querySelector('section[aria-label="Create something new"]')).not.toBeNull();

  await act(async () => {
    set?.call(search, 'flow');
    search?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settled(() => titles().length === 1);

  expect(titles()).toEqual(['Flow']);
  expect(api.profileArtifacts).toHaveBeenLastCalledWith(profile.id, { q: 'flow', pinned: 'false' });
  // Looking for one is not the moment to offer making another.
  expect(container.querySelector('section[aria-label="Create something new"]')).toBeNull();
});

it('changes who reads one only inside it, never from its card', async () => {
  await render(gateway());

  expect(button('Public: anyone with the link')).toBeUndefined();
  expect(button('Private: only you')).toBeUndefined();

  await click(button('Open Landing'));
  await settled(() => Boolean(container.querySelector('iframe')));
  expect(button('Public: anyone with the link', container)).toBeDefined();
});

it('opens one in the page with the Inspector’s own view, and comes back to the cards', async () => {
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
  expect(memoryNavigation.current()).toBe(artifactsPath(profile.id));
});

it('keeps the one open in the address, so the browser’s back comes to the cards', async () => {
  await render(gateway());

  await click(button('Open Landing'));
  await settled(() => Boolean(container.querySelector('iframe')));
  expect(memoryNavigation.current()).toBe(`${artifactsPath(profile.id)}?artifact=${landing.id}`);

  await act(async () => memoryNavigation.back());
  expect(titles()).toEqual(['Landing', 'Release notes']);
  expect(memoryNavigation.current()).toBe(artifactsPath(profile.id));

  // One the address opened has nothing of the page behind it: back is to the cards in its place.
  await act(async () => memoryNavigation.go(`${artifactsPath(profile.id)}?artifact=${notes.id}`));
  await settled(() => button('All artifacts', container) !== undefined);
  await click(button('All artifacts', container));
  expect(titles()).toEqual(['Landing', 'Release notes']);
  expect(memoryNavigation.current()).toBe(artifactsPath(profile.id));
});

it('offers a card’s menu, with the link only of one that is public', async () => {
  await render(gateway());
  const offered = async (artifact: ProfileArtifact) => {
    await click(button(`Actions for ${artifact.title}`));
    await settled(() => entries().length > 0);
    const names = entries().map((item) => item.textContent);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await settled(() => entries().length === 0);
    return names;
  };

  expect(await offered(notes)).toEqual([
    'Pin',
    'Rename',
    'Duplicate',
    'Open conversation',
    'Move to folder',
    'Delete',
  ]);
  expect(await offered(landing)).toContain('Copy link');
});

it('pins one, which then leads the page in a section of its own', async () => {
  const api = gateway();
  await render(api);

  await click(button('Pin Release notes'));
  await settled(() => titles('Pinned artifacts').length === 1);

  expect(api.updateSessionArtifact).toHaveBeenCalledWith(profile.id, notes.sessionId, notes.id, {
    pinned: true,
  });
  expect(titles('Pinned artifacts')).toEqual(['Release notes']);
  expect(titles()).toEqual(['Landing', 'Flow']);

  await click(button('Unpin Release notes'));
  await settled(() => titles('Pinned artifacts').length === 0);
  expect(titles()).toEqual(['Landing', 'Release notes']);
});

it('renames one from a dialog, and copies one beside it', async () => {
  const api = gateway();
  await render(api);

  await entry(landing, 'Rename');
  await name('Home page');
  await settled(() => titles().includes('Home page'));
  expect(api.updateSessionArtifact).toHaveBeenCalledWith(profile.id, chat.id, landing.id, {
    title: 'Home page',
  });

  await entry(notes, 'Duplicate');
  await settled(() => titles().includes('Release notes (copy)'));
  expect(api.duplicateSessionArtifact).toHaveBeenCalledWith(profile.id, notes.sessionId, notes.id);
});

it('goes to the conversation with the Artifact open in its Inspector', async () => {
  await render(gateway());

  await entry(landing, 'Open conversation');

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

it('keeps each under its conversation’s project until it is moved to a folder', async () => {
  const api = gateway();
  await render(api);

  expect(
    [...container.querySelectorAll('[aria-label="Folder"] button')].map((item) => item.textContent),
  ).toEqual(['All', 'Site1', 'No project2', 'Keepers0']);

  await click(place('Site'));
  await settled(() => titles().length === 1);
  expect(titles()).toEqual(['Landing']);
  expect(api.profileArtifacts).toHaveBeenLastCalledWith(profile.id, {
    project: site.id,
    pinned: 'false',
  });

  // Moved from its card's menu, to a folder the owner made.
  await click(button(`Actions for ${landing.title}`));
  await settled(() => entries().length > 0);
  await click(entries().find((item) => item.textContent === 'Move to folder'));
  await settled(() => entries().some((item) => item.textContent === 'Keepers'));
  await click(entries().find((item) => item.textContent === 'Keepers'));
  await settled(() => api.updateSessionArtifact.mock.calls.length > 0);
  expect(api.updateSessionArtifact).toHaveBeenCalledWith(profile.id, chat.id, landing.id, {
    folderId: keepers.id,
  });

  // The project holds nothing more, so it is no place any longer: the page shows all again.
  await settled(() => !place('Site'));
  await click(place('Keepers'));
  await settled(() => titles().length === 1 && titles()[0] === 'Landing');
  expect(api.profileArtifacts).toHaveBeenLastCalledWith(profile.id, {
    folder: keepers.id,
    pinned: 'false',
  });
});

it('makes a folder and goes to it, renames it, and deletes it alone', async () => {
  const api = gateway([{ ...landing, folderId: keepers.id }, notes]);
  await render(api);

  await click(button('New folder', container));
  await name('Drafts');
  await settled(() => Boolean(place('Drafts')));
  expect(api.createArtifactFolder).toHaveBeenCalledWith(profile.id, 'Drafts');
  await settled(() => container.textContent?.includes('Nothing in this folder yet') ?? false);

  await click(place('Keepers'));
  await settled(() => Boolean(button('Actions for folder Keepers')));
  await click(button('Actions for folder Keepers'));
  await settled(() => entries().length > 0);
  await click(entries().find((item) => item.textContent === 'Rename folder'));
  await name('Kept');
  await settled(() => Boolean(place('Kept')));
  expect(api.renameArtifactFolder).toHaveBeenCalledWith(profile.id, keepers.id, 'Kept');

  await settled(() => entries().length === 0 && Boolean(button('Actions for folder Kept')));
  await click(button('Actions for folder Kept'));
  await settled(() => entries().length > 0);
  await click(entries().find((item) => item.textContent === 'Delete folder'));
  await settled(() => Boolean(button('Delete folder', dialog())));
  expect(dialog().textContent).toContain('Only the folder is deleted');
  expect(api.deleteArtifactFolder).not.toHaveBeenCalled();
  await click(button('Delete folder', dialog()));
  await settled(() => !place('Kept'));

  expect(api.deleteArtifactFolder).toHaveBeenCalledWith(profile.id, keepers.id);
  // What it held is back under its project, and the page back at all of them.
  await settled(() => titles().length === 2);
  expect(titles()).toEqual(['Landing', 'Release notes']);
  expect(api.deleteSessionArtifact).not.toHaveBeenCalled();
});

it('starts a conversation that asks for a new one, in the project of the folder open', async () => {
  await render(gateway());
  const shortcut = () =>
    [...container.querySelectorAll('section[aria-label="Create something new"] button')].find(
      (item) => item.textContent === 'Deck',
    );

  await click(shortcut());
  expect(memoryNavigation.current()).toBe(`/agents/${profile.id}/sessions?new`);
  // Left written where the new conversation's field reads it; nothing was sent.
  expect(useDrafts.getState().texts[draftKey(profile.id)]).toMatch(/deck of slides as an Artifact/);

  await click(place('Site'));
  await settled(() => titles().length === 1);
  await click(shortcut());
  expect(memoryNavigation.current()).toBe(`/agents/${profile.id}/sessions?new&project=${site.id}`);
});

it('deletes one only after asking', async () => {
  const api = gateway();
  await render(api);

  await entry(landing, 'Delete');
  await settled(() => Boolean(dialog()));
  expect(dialog().textContent).toContain('Delete Landing?');
  expect(dialog().textContent).toContain('its public link stops working');
  expect(api.deleteSessionArtifact).not.toHaveBeenCalled();

  await click(button('Delete Artifact', dialog()));
  await settled(() => !titles().includes('Landing'));

  expect(api.deleteSessionArtifact).toHaveBeenCalledWith(profile.id, chat.id, landing.id);
  expect(titles()).toEqual(['Release notes', 'Flow']);
});

it('keeps the page as it was when the gateway refuses a change', async () => {
  const api = gateway();
  api.deleteSessionArtifact.mockRejectedValueOnce(new Error('The gateway could not delete it.'));
  api.updateSessionArtifact.mockRejectedValueOnce(new Error('The gateway could not change it.'));
  await render(api);

  await click(button('Pin Landing'));
  await settled(() => api.updateSessionArtifact.mock.calls.length > 0);
  expect(titles('Pinned artifacts')).toEqual([]);

  await entry(notes, 'Delete');
  await settled(() => Boolean(dialog()));
  await click(button('Delete Artifact', dialog()));
  await settled(() => api.deleteSessionArtifact.mock.calls.length > 0);

  expect(titles()).toEqual(['Landing', 'Release notes']);
});

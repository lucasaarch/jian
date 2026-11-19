import { ARTIFACT_PRESENT_MESSAGE, SESSION_ARTIFACT_MAX } from '@jian/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckExportQuery, SessionArtifact } from '../../../lib/api';
import { publish } from '../../../lib/events';
import { keys } from '../../../lib/query/keys';
import { useArtifactDraft } from '../../../lib/stores/artifact-draft';
import { useCrew } from '../../../lib/stores/crew';
import { draftKey, useDrafts } from '../../../lib/stores/drafts';
import { focusInspector } from '../inspector-host';
import type { ArtifactsDrawerApi } from './artifact-cards';
import { ArtifactsDrawer } from './artifacts-drawer';
import { collectEdit, editAnswer } from './edit';
import { hearArtifactDraft } from './live';
import { fileName } from './source';

// The toast is read, not shown: a test says what the owner is told.
vi.mock('sonner', async (original) => {
  const real = await original<typeof import('sonner')>();

  return { ...real, toast: Object.assign(vi.fn(), real.toast) };
});

const SOURCE = 'export default () => <button>Count</button>;';
const COMPILED = "exports.default = () => React.createElement('button', null, 'Count');";
const at = '2026-11-18T10:00:00.000Z';
const counter: SessionArtifact = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: 'session',
  title: 'Counter',
  type: 'react',
  visibility: 'private',
  version: 1,
  publicPath: null,
  createdAt: at,
  updatedAt: at,
};
const notes: SessionArtifact = {
  ...counter,
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Launch notes',
  type: 'markdown',
  version: 3,
};
const PAGE = '<!doctype html><html><body><h1>Launch</h1></body></html>';
const page: SessionArtifact = {
  ...counter,
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Landing',
  type: 'html',
  version: 2,
};
const SLIDES = ['One', 'Two', 'Three'].map(
  (text) => `<!doctype html><html><body><h1>${text}</h1></body></html>`,
);
const deck: SessionArtifact = {
  ...counter,
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Plan',
  type: 'deck',
};
const sheet: SessionArtifact = {
  ...counter,
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Budget',
  type: 'sheet',
};

function gateway(artifacts: SessionArtifact[] = [counter, notes, page, deck]) {
  const held = [...artifacts];
  const keyed = new Map<string, string>();

  return {
    held,
    sessionArtifacts: vi.fn(async () => [...held]),
    sessionArtifactVersion: vi.fn(
      async (_profile: string, _session: string, artifactId: string, version: number) => ({
        artifactId,
        version,
        author: 'agent' as const,
        content:
          artifactId === counter.id
            ? SOURCE
            : artifactId === page.id
              ? PAGE
              : artifactId === deck.id
                ? JSON.stringify({ slides: SLIDES })
                : `# Notes, version ${version}`,
        ...(artifactId === counter.id ? { compiled: COMPILED } : {}),
        ...(artifactId === deck.id ? { slides: SLIDES } : {}),
        createdAt: at,
      }),
    ),
    exportSessionArtifact: vi.fn(
      async (
        _profile: string,
        _session: string,
        _artifactId: string,
        _version: number,
        wanted: { format: DeckExportQuery['format']; slide?: number; fonts?: 'current' | 'basic' },
      ) => ({ mimeType: `test/${wanted.format}`, data: btoa(`drawn as ${wanted.format}`) }),
    ),
    editSessionArtifact: vi.fn(
      async (
        _profile: string,
        _session: string,
        artifactId: string,
        edit: { version: number; content: string; slide?: number; editKey?: string },
      ) => {
        const index = held.findIndex((item) => item.id === artifactId);
        const current = held[index] as SessionArtifact;
        // As the gateway does: a key already used on the latest version writes over it.
        const again = edit.editKey !== undefined && keyed.get(artifactId) === edit.editKey;
        if (edit.editKey) keyed.set(artifactId, edit.editKey);
        const next: SessionArtifact = { ...current, version: current.version + (again ? 0 : 1) };
        held[index] = next;
        return next;
      },
    ),
    setSessionArtifactVisibility: vi.fn(
      async (
        _profile: string,
        _session: string,
        artifactId: string,
        visibility: SessionArtifact['visibility'],
      ) => {
        const index = held.findIndex((item) => item.id === artifactId);
        const next: SessionArtifact = {
          ...(held[index] as SessionArtifact),
          visibility,
          publicPath: visibility === 'public' ? `/v1/public-artifacts/${'A'.repeat(43)}` : null,
        };
        held[index] = next;
        return next;
      },
    ),
    updateSessionArtifact: vi.fn(
      async (
        _profile: string,
        _session: string,
        artifactId: string,
        change: { title?: string; pinned?: boolean; folderId?: string | null },
      ) => {
        const index = held.findIndex((item) => item.id === artifactId);
        const next: SessionArtifact = { ...(held[index] as SessionArtifact), ...change };
        held[index] = next;
        return next;
      },
    ),
    duplicateSessionArtifact: vi.fn(async (_profile: string, _session: string, id: string) => {
      const copy: SessionArtifact = {
        ...(held.find((item) => item.id === id) as SessionArtifact),
        id: '55555555-5555-4555-8555-555555555555',
        version: 1,
      };
      held.unshift(copy);
      return copy;
    }),
    deleteSessionArtifact: vi.fn(async (_profile: string, _session: string, artifactId: string) => {
      held.splice(
        held.findIndex((item) => item.id === artifactId),
        1,
      );
      return null;
    }),
    // The Inspector's cards make no folder; the page's do.
    createArtifactFolder: vi.fn(),
    renameArtifactFolder: vi.fn(),
    deleteArtifactFolder: vi.fn(),
  } satisfies ArtifactsDrawerApi & { held: SessionArtifact[] };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useCrew.getState().show('session', []);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  // Emptied before it is left: a conversation left with tabs gets them back when shown again.
  useCrew.setState({ tabs: [], opened: false, following: undefined });
  useCrew.getState().leave('session');
  useDrafts.getState().forgetAll();
  useArtifactDraft.setState({ byConversation: {} });
});

async function settled(done: () => boolean, limit = 100) {
  for (let tries = 0; tries < limit && !done(); tries += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

async function render(api: ArtifactsDrawerApi, mode: 'server' | 'local' = 'server') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // What kind of gateway this is, as its health answer said.
  client.setQueryData(keys.gateway, { status: 'ok', mode });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ArtifactsDrawer api={api} profileId="profile" />
      </QueryClientProvider>,
    ),
  );
}

const drawer = () => container.querySelector('aside');
const frame = () => container.querySelector('iframe');
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((item) =>
    item.getAttribute('aria-label')?.startsWith(label),
  );
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | undefined)?.click());

/** The frame as the browser would have loaded it, with a window that records what it is sent. */
async function loaded(element = frame() as HTMLIFrameElement) {
  const sent = vi.fn();

  Object.defineProperty(element, 'contentWindow', { value: { postMessage: sent } });
  await act(async () => element.dispatchEvent(new Event('load')));
  return { element, sent };
}

async function opened(artifact: SessionArtifact, api = gateway(), mode?: 'server' | 'local') {
  await act(async () => useCrew.getState().showArtifacts(artifact.id));
  await render(api, mode);
  await settled(() => Boolean(frame()));
  return api;
}

/** The version in view: the one last read from the gateway. */
const viewed = (api: ReturnType<typeof gateway>) =>
  api.sessionArtifactVersion.mock.calls.at(-1)?.[3];
/** The older version in view, as the bar names it beside the title; none for the latest. */
const older = () => drawer()?.querySelector('h2')?.nextElementSibling?.textContent || undefined;

/** The names on the tab's cards, in order. */
const cards = () =>
  [
    ...(drawer()?.querySelectorAll(
      'ul[aria-label="Artifacts"] > li > button[aria-label^="Open "]',
    ) ?? []),
  ].map((card) => card.getAttribute('aria-label')?.replace(/^Open /, ''));
/** One of Create something new's shortcuts, by the kind it makes. */
const starter = (kind: string) =>
  [...(drawer()?.querySelectorAll('section[aria-label="Create something new"] button') ?? [])].find(
    (item) => item.textContent === kind,
  );
const entries = () => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
/** A bar button's menu, opened once the one before has closed: its entries. */
async function menu(label: string) {
  await settled(() => entries().length === 0);
  await click(button(label));
  await settled(() => entries().length > 0);
  return entries();
}

/** The tab of the conversation's cards, read. */
async function listed(api = gateway()) {
  await act(async () => useCrew.getState().showArtifacts());
  await render(api);
  await settled(() => cards().length > 0);
  return api;
}

async function search(words: string) {
  const field = drawer()?.querySelector('input[aria-label="Search artifacts"]') as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    set?.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the Artifacts tab', () => {
  it('shows what the agent made as the Artifacts page’s cards, and opens one', async () => {
    const api = await listed();

    expect(cards()).toEqual(['Counter', 'Launch notes', 'Landing', 'Plan']);
    expect(button('All artifacts')).toBeUndefined();

    await click(button('Open Launch notes'));
    await settled(() => Boolean(button('All artifacts')));

    expect(drawer()?.querySelector('h2')?.textContent).toBe('Launch notes');
    expect(viewed(api)).toBe(3);

    await click(button('All artifacts'));
    expect(button('All artifacts')).toBeUndefined();
    expect(cards()).toHaveLength(4);
  });

  it('narrows the cards from its bar, by words of the title and by type', async () => {
    await listed();

    await search('LAUNCH');
    expect(cards()).toEqual(['Launch notes']);
    // Narrowed, the shortcuts make way for what was found, as on the page.
    expect(starter('Slide')).toBeUndefined();

    await search('nothing like it');
    expect(cards()).toEqual([]);
    expect(drawer()?.textContent).toContain('No Artifact matches.');

    await search('');
    await click(button('Type'));
    await settled(() => document.querySelectorAll('[role="option"]').length > 0);
    await click(
      [...document.querySelectorAll('[role="option"]')].find((item) =>
        item.textContent?.includes('Web page'),
      ),
    );
    expect(cards()).toEqual(['Landing']);
  });

  it('begins a request in this conversation’s own field, after what is written there', async () => {
    const field = draftKey('profile', 'session');
    useDrafts.getState().write(field, 'Hello ');
    const api = await listed();

    await click(starter('Slide'));

    expect(useDrafts.getState().texts[field]).toBe('Hello\n\nCreate slides as an Artifact about ');
    // Nothing was made: the owner finishes the request and sends it.
    expect(api.duplicateSessionArtifact).not.toHaveBeenCalled();
    expect(api.editSessionArtifact).not.toHaveBeenCalled();
  });

  it('renames, duplicates and deletes from a card’s menu, deleting only after asking', async () => {
    const api = await listed();
    const pick = async (artifact: SessionArtifact, name: string) => {
      await settled(() => entries().length === 0);
      await click(button(`Actions for ${artifact.title}`));
      await settled(() => entries().length > 0);
      const names = entries().map((item) => item.textContent);
      await click(entries().find((item) => item.textContent === name));
      return names;
    };

    // Pins and folders are the page's, across every conversation; it is in this one already.
    expect(await pick(page, 'Duplicate')).toEqual(['Rename', 'Duplicate', 'Delete']);
    await settled(() => cards().length === 5);
    expect(api.duplicateSessionArtifact).toHaveBeenCalledWith('profile', 'session', page.id);

    await pick(notes, 'Delete');
    const dialog = () => document.querySelector('[role=dialog]') as HTMLElement;
    await settled(() => Boolean(dialog()));
    expect(dialog().textContent).toContain('Delete Launch notes?');
    expect(api.deleteSessionArtifact).not.toHaveBeenCalled();

    await click(
      [...dialog().querySelectorAll('button')].find(
        (item) => item.textContent === 'Delete Artifact',
      ),
    );
    await settled(() => !cards().includes('Launch notes'));
    expect(api.deleteSessionArtifact).toHaveBeenCalledWith('profile', 'session', notes.id);
  });

  it('says so when the conversation has none, and still offers to make one', async () => {
    await act(async () => useCrew.getState().showArtifacts());
    await render(gateway([]));
    await settled(() => !drawer()?.querySelector('[role=status]'));

    expect(drawer()?.textContent).toContain('Nothing here yet');
    expect(starter('Slide')).toBeDefined();
  });

  it('draws nothing while another tab is in front', async () => {
    await render(gateway());

    expect(drawer()).toBeNull();
  });
});

describe('the frame an Artifact runs in', () => {
  it('may run scripts and nothing else, and is the gateway’s empty frame', async () => {
    await opened(counter);

    // Any other token here, `allow-same-origin` above all, would give the Artifact the panel.
    expect(frame()?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame()?.getAttribute('src')).toBe(
      `${window.location.origin}/v1/artifact-frames/react?theme=dark`,
    );
    // The address names a type and nothing of the Artifact.
    expect(frame()?.getAttribute('src')).not.toContain(counter.id);
    expect(frame()?.hasAttribute('srcdoc')).toBe(false);
  });

  it('is handed the source once, compiled for a component, and never again', async () => {
    await opened(counter);
    const { element, sent } = await loaded();

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith({ jianArtifact: COMPILED }, '*');

    // The Artifact loading its frame again, or taking it elsewhere, gets nothing more.
    await act(async () => element.dispatchEvent(new Event('load')));
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('is never listened to by the panel', async () => {
    const heard = vi.spyOn(window, 'addEventListener');

    await opened(counter);
    await loaded();

    expect(heard.mock.calls.filter(([type]) => type === 'message')).toEqual([]);
    heard.mockRestore();
  });

  it('gives way to the source as written, and comes back', async () => {
    await opened(counter);

    await click(button('View code'));
    expect(frame()).toBeNull();
    // What the owner reads and copies is what the agent wrote, not what the frame runs.
    expect(drawer()?.querySelector('pre')?.textContent).toContain(SOURCE);
    expect(drawer()?.textContent).not.toContain('createElement');

    await click(button('View code'));
    expect(frame()).not.toBeNull();
  });
});

describe('an Artifact the agent updates', () => {
  it('opens when the agent makes it, and moves to its new version', async () => {
    const api = gateway();
    await render(api);

    // The gateway's event for create_artifact: the tab opens on that one.
    const made = { sessionId: 'session', kind: 'artifact', artifactId: notes.id };
    await act(async () => focusInspector('session', made));
    await settled(() => Boolean(frame()));
    expect(viewed(api)).toBe(3);
    const first = frame();

    api.held[1] = { ...notes, version: 4 };
    await act(async () => publish({ id: 1, type: 'conversation.inspector.focus', data: made }));
    await settled(() => viewed(api) === 4);

    expect(older()).toBeUndefined();
    // A new version is a new frame, not the old one told to draw again.
    await settled(() => Boolean(frame()) && frame() !== first);
    expect(frame()).not.toBe(first);
    expect(api.sessionArtifactVersion).toHaveBeenLastCalledWith('profile', 'session', notes.id, 4);
  });

  it('does not open for another conversation’s Artifact', async () => {
    await render(gateway());
    await act(async () =>
      focusInspector('session', { sessionId: 'elsewhere', kind: 'artifact', artifactId: notes.id }),
    );

    expect(drawer()).toBeNull();
  });
});

describe('who can read an Artifact', () => {
  const entries = () => [
    ...document.querySelectorAll<HTMLElement>('[role=menuitem], [role=menuitemcheckbox]'),
  ];

  it('offers no public link on the gateway a desktop app runs', async () => {
    await opened(counter, gateway(), 'local');

    expect(button('Private')).toBeUndefined();
    expect(button('Public')).toBeUndefined();
    // Everything else is still there, behind the bar's one button of options.
    await click(button('Artifact options'));
    await settled(() => entries().length > 0);
    expect(entries().map((entry) => entry.textContent)).toEqual(['Copy source', 'Download']);
  });

  it('makes one public on a server, with a link to copy from the gateway’s own address', async () => {
    const copied = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: copied },
      configurable: true,
    });
    const api = await opened(counter, gateway(), 'server');

    await click(button('Private'));
    await settled(() => entries().length > 0);
    expect(entries().map((entry) => entry.textContent)).toEqual(['Public link']);

    await click(entries()[0]);
    await settled(() => entries().length > 1);
    expect(api.setSessionArtifactVisibility).toHaveBeenCalledWith(
      'profile',
      'session',
      counter.id,
      'public',
    );
    expect(button('Public')).toBeDefined();

    await click(entries().find((entry) => entry.textContent === 'Copy link'));
    expect(copied).toHaveBeenCalledWith(
      `${window.location.origin}/v1/public-artifacts/${'A'.repeat(43)}`,
    );
  });
});

/** A button named by its words, as Save and Cancel are. */
const named = (words: string) =>
  [...container.querySelectorAll('button')].find((item) => item.textContent === words);

/** A message as the browser delivers it to the panel, from the window that sent it. */
const answer = (source: unknown, said: object) =>
  act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { jianArtifactEdit: said },
        source: source as MessageEventSource,
      }),
    );
  });

/** The word the panel last asked a frame to answer with. */
const asked = (sent: ReturnType<typeof vi.fn>): string =>
  sent.mock.calls.at(-1)?.[0].jianArtifactEdit.collect;

const listening = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([type]) => type === 'message').length;

/** What the editing frame says when the owner changes something: a fact, with no content. */
const changed = (element: HTMLIFrameElement) => answer(element.contentWindow, { changed: true });
/** How many times the panel asked the frame for its source. */
const questions = (sent: ReturnType<typeof vi.fn>) =>
  sent.mock.calls.filter(([said]) => said.jianArtifactEdit?.collect).length;
/** Time passing, with the promises it wakes settled. */
const wait = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

describe('editing one by hand', () => {
  afterEach(() => vi.useRealTimers());

  it('is offered after Edit for a page and a deck, and open at once for a document', async () => {
    for (const [artifact, offered] of [
      [counter, false],
      [notes, false],
      [page, true],
      [deck, true],
    ] as const) {
      await opened(artifact);
      await settled(() => drawer()?.querySelector('h2')?.textContent === artifact.title);
      expect(Boolean(button('Edit'))).toBe(offered);
    }

    await opened(notes);
    await settled(() => frame()?.getAttribute('src')?.endsWith('?edit=1') === true);
    expect(frame()?.getAttribute('src')).toBe(
      `${window.location.origin}/v1/artifact-frames/markdown?edit=1`,
    );
  });

  it('opens the page in the frame that edits, as sealed as the one that draws', async () => {
    await opened(page);
    await click(button('Edit'));

    expect(frame()?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame()?.getAttribute('src')).toBe(
      `${window.location.origin}/v1/artifact-frames/html?edit=1&theme=dark`,
    );
    expect(frame()?.getAttribute('src')).not.toContain(page.id);
    const { sent } = await loaded();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith({ jianArtifact: PAGE, jianArtifactEdit: { scale: 1 } }, '*');
    // Done, not Save and Cancel: nothing is kept by hand.
    expect(named('Save')).toBeUndefined();
    expect(named('Cancel')).toBeUndefined();

    await click(named('Done'));
    expect(frame()?.getAttribute('src')).toBe(
      `${window.location.origin}/v1/artifact-frames/html?theme=dark`,
    );
    expect(button('History')).toBeDefined();
  });

  it('listens to the frame only while it is open for editing, and only to its own window', async () => {
    const heard = vi.spyOn(window, 'addEventListener');
    const api = await opened(page);
    expect(listening(heard)).toBe(0);

    await click(button('Edit'));
    const { sent } = await loaded();
    expect(listening(heard)).toBe(1);
    vi.useFakeTimers();

    // Another window, and a frame that is not this one: neither makes the panel ask.
    await answer(window, { changed: true });
    await answer({ postMessage: vi.fn() }, { changed: true });
    await wait(5000);
    expect(questions(sent)).toBe(0);
    expect(api.editSessionArtifact).not.toHaveBeenCalled();
    heard.mockRestore();
  });

  it('keeps an edit a moment after the owner stops, and the whole stretch as one version', async () => {
    const api = await opened(page);
    await click(button('Edit'));
    const { element, sent } = await loaded();
    vi.useFakeTimers();

    await changed(element);
    await wait(1400);
    // Still typing, as far as it knows: nothing yet.
    expect(questions(sent)).toBe(0);
    await changed(element);
    await wait(1400);
    expect(questions(sent)).toBe(0);
    await wait(200);
    expect(questions(sent)).toBe(1);

    const first = PAGE.replace('Launch', 'Launched');
    await answer(element.contentWindow, { collect: asked(sent), html: first });
    expect(api.editSessionArtifact).toHaveBeenCalledTimes(1);
    expect(api.editSessionArtifact).toHaveBeenCalledWith('profile', 'session', page.id, {
      version: 2,
      content: first,
      editKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(drawer()?.textContent).toContain('Saved');
    // The frame is not taken from under the owner's hands, and nothing here is asked to be pressed.
    expect(frame()).toBe(element);
    expect(named('Save')).toBeUndefined();
    expect(named('Try again')).toBeUndefined();

    // The next pause is the same stretch: the same key, from the version it made.
    await changed(element);
    await wait(1500);
    const second = first.replace('Launched', 'Launched again');
    await answer(element.contentWindow, { collect: asked(sent), html: second });
    const [, , , one] = api.editSessionArtifact.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { editKey: string },
    ];
    expect(api.editSessionArtifact).toHaveBeenLastCalledWith('profile', 'session', page.id, {
      version: 3,
      content: second,
      editKey: one.editKey,
    });

    // Done shows what was kept, as the latest.
    await click(named('Done'));
    vi.useRealTimers();
    await settled(() => viewed(api) === 3);
    expect(viewed(api)).toBe(3);
    expect(older()).toBeUndefined();
  });

  it('keeps it when the owner leaves, without waiting for the pause', async () => {
    const api = await opened(page);
    await click(button('Edit'));
    const { element, sent } = await loaded();
    vi.useFakeTimers();

    await changed(element);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    hidden.mockRestore();
    expect(questions(sent)).toBe(1);

    await answer(element.contentWindow, {
      collect: asked(sent),
      html: PAGE.replace('Launch', 'X'),
    });
    expect(api.editSessionArtifact).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing when nothing was edited, and tries again by itself when it cannot keep it', async () => {
    const api = await opened(page);
    await click(button('Edit'));
    const { element, sent } = await loaded();
    vi.useFakeTimers();

    await changed(element);
    await wait(1500);
    await answer(element.contentWindow, { collect: asked(sent), unchanged: true });
    expect(api.editSessionArtifact).not.toHaveBeenCalled();

    // An answer that cannot be kept: said quietly, no button, and asked again in a few seconds.
    await changed(element);
    await wait(1500);
    await answer(element.contentWindow, {
      collect: asked(sent),
      html: 'x'.repeat(SESSION_ARTIFACT_MAX + 1),
    });
    expect(drawer()?.textContent).toContain('Trying again');
    expect(named('Try again')).toBeUndefined();
    await wait(4000);
    expect(questions(sent)).toBe(3);
    await answer(element.contentWindow, {
      collect: asked(sent),
      html: PAGE.replace('Launch', 'Y'),
    });
    expect(api.editSessionArtifact).toHaveBeenCalledTimes(1);
    expect(drawer()?.textContent).toContain('Saved');
  });

  it('says so when the agent wrote a version meanwhile, and the edit lands on top', async () => {
    const api = await opened(page);
    api.editSessionArtifact.mockImplementationOnce(async (_p, _s, id) => {
      const index = api.held.findIndex((item) => item.id === id);
      const next = { ...(api.held[index] as SessionArtifact), version: 4 };
      api.held[index] = next;
      return next;
    });
    await click(button('Edit'));
    const { element, sent } = await loaded();
    vi.useFakeTimers();

    await changed(element);
    await wait(1500);
    await answer(element.contentWindow, {
      collect: asked(sent),
      html: PAGE.replace('Launch', 'Z'),
    });

    expect(toast).toHaveBeenCalledWith(expect.stringContaining('as version 4'));
  });
});

describe('an Artifact being written', () => {
  const writing = (content: string, more: object = {}) => ({
    toolCallId: 'call',
    title: 'Plan',
    type: 'markdown' as const,
    content,
    ...more,
  });
  const told = (draft: ReturnType<typeof writing> | undefined) =>
    act(async () => hearArtifactDraft('session', draft));

  it('opens the tab on the writing, grows with it, and gives way to the drawn version', async () => {
    const api = gateway([]);
    await render(api);

    await told(writing('# Plan'));
    expect(drawer()?.querySelector('h2')?.textContent).toBe('Plan');
    expect(drawer()?.textContent).toContain('Writing…');
    expect(drawer()?.querySelector('article')?.textContent).toContain('Plan');
    expect(frame()).toBeNull();

    await told(writing('# Plan\n\nThe first step.'));
    expect(drawer()?.querySelector('article')?.textContent).toContain('The first step.');

    // The tool ran: the version exists, and takes the writing's place once it is read.
    const made: SessionArtifact = { ...notes, title: 'Plan', version: 1 };
    api.held.unshift(made);
    await told(undefined);
    await act(async () =>
      focusInspector('session', { sessionId: 'session', kind: 'artifact', artifactId: made.id }),
    );
    await settled(() => Boolean(frame()));
    expect(frame()).not.toBeNull();
    expect(useArtifactDraft.getState().byConversation.session).toBeUndefined();
    expect(drawer()?.textContent).not.toContain('Writing…');
  });

  it('shows the source growing for anything but a document', async () => {
    await render(gateway([]));

    await told(writing('<h1>Hi', { type: 'html' }));
    expect(drawer()?.querySelector('pre')?.textContent).toContain('<h1>Hi');
    expect(drawer()?.querySelector('article')).toBeNull();
  });

  it('keeps the current version in view until the update has words, then streams them', async () => {
    const api = gateway();
    await opened(notes, api);
    await settled(() => drawer()?.querySelector('h2')?.textContent === notes.title);

    // Named but not yet written: the version stays, with the quiet word beside it.
    await told(writing('', { artifactId: notes.id }));
    expect(frame()).not.toBeNull();
    expect(drawer()?.textContent).toContain('Writing…');

    await told(writing('# New words', { artifactId: notes.id }));
    expect(frame()).toBeNull();
    expect(drawer()?.querySelector('article')?.textContent).toContain('New words');

    api.held[api.held.findIndex((item) => item.id === notes.id)] = { ...notes, version: 4 };
    await told(undefined);
    await settled(() => Boolean(frame()));
    expect(viewed(api)).toBe(4);
    expect(drawer()?.textContent).not.toContain('Writing…');
  });

  it('moves no focus when it opens the tab by itself', async () => {
    await listed();
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();

    // The tab opens on it by itself, as the agent's own request to show one does.
    await told(writing('', { artifactId: notes.id }));
    expect(document.activeElement).toBe(composer);
    expect(drawer()?.textContent).toContain('Writing…');
    composer.remove();
  });
});

describe('the versions of an Artifact', () => {
  const choices = () => [...document.querySelectorAll<HTMLElement>('[role=menuitemradio]')];
  const listed = async () => {
    await click(button('History'));
    await settled(() => choices().length > 0);
    return choices().map(
      (choice) =>
        `${choice.textContent}${choice.getAttribute('aria-checked') === 'true' ? ' (in view)' : ''}`,
    );
  };

  it('are behind one button of the bar, the latest marked, and one is picked from there', async () => {
    const api = await opened(notes);
    // The bar holds no select of versions: the title, and nothing beside it at the latest.
    expect(older()).toBeUndefined();

    expect(await listed()).toEqual(['Version 3 · latest (in view)', 'Version 2', 'Version 1']);
    await click(choices()[1]);
    await settled(() => viewed(api) === 2);
    expect(viewed(api)).toBe(2);
    expect(older()).toBe('v2');
    await settled(() => choices().length === 0);

    expect(await listed()).toEqual(['Version 3 · latest', 'Version 2 (in view)', 'Version 1']);
    await click(choices()[0]);
    await settled(() => older() === undefined);
    expect(older()).toBeUndefined();
  });
});

describe('a deck of slides', () => {
  const frames = () => [...container.querySelectorAll('iframe')];
  /**
   * The slide in view in the track, which holds the ones beside it too. Open for editing, the
   * view frame stays under the editing one, which is the last.
   */
  const large = () =>
    [...container.querySelectorAll('[data-current] iframe')].at(-1) as HTMLIFrameElement;
  const presented = () => document.querySelector('[role=dialog]');

  it('rows its slides small on top, each sealed, and shows one large under them', async () => {
    await opened(deck);

    const rail = drawer()?.querySelector('nav[aria-label=Slides]');
    expect(
      [...(rail?.querySelectorAll('button') ?? [])].map((item) => item.getAttribute('aria-label')),
    ).toEqual(['Slide 1', 'Slide 2', 'Slide 3']);
    // The row comes before the slide in view, not beside it.
    expect(
      (rail as Element).compareDocumentPosition(large()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Three small ones, and of the large ones the slide in view and the one after it.
    expect(frames().map((item) => item.title)).toEqual([
      'Slide 1, small',
      'Slide 2, small',
      'Slide 3, small',
      'Plan, slide 1',
      'Plan, slide 2',
    ]);
    for (const item of frames()) {
      expect(item.getAttribute('sandbox')).toBe('allow-scripts');
      expect(item.getAttribute('src')).toBe(
        `${window.location.origin}/v1/artifact-frames/deck?theme=dark`,
      );
      expect(item.hasAttribute('srcdoc')).toBe(false);
    }
    expect(large()?.title).toBe('Plan, slide 1');
    expect(button('Slide 1')?.getAttribute('aria-current')).toBe('true');
    expect(button('Previous slide')?.disabled).toBe(true);

    // Each frame is handed its own slide, and only that.
    expect((await loaded(large())).sent).toHaveBeenCalledWith({ jianArtifact: SLIDES[0] }, '*');

    await click(button('Slide 3'));
    expect(large()?.title).toBe('Plan, slide 3');
    expect(button('Slide 3')?.getAttribute('aria-current')).toBe('true');
    expect(drawer()?.textContent).toContain('3 / 3');
    expect(button('Next slide')?.disabled).toBe(true);
    await click(button('Previous slide'));
    expect(large()?.title).toBe('Plan, slide 2');
    expect(button('Slide 2')?.getAttribute('aria-current')).toBe('true');
    expect((await loaded(large())).sent).toHaveBeenCalledWith({ jianArtifact: SLIDES[1] }, '*');

    // A deck is read as slides: there is no code to switch to.
    expect(button('View code')).toBeUndefined();
  });

  it('follows the track to the slide it is scrolled to', async () => {
    await opened(deck);
    const track = large().closest('[data-current]')?.parentElement as HTMLElement;
    // Three slides side by side, each as wide as the track, as a browser lays them out.
    Object.defineProperty(track, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(track, 'scrollWidth', { value: 1200, configurable: true });
    const scrollTo = async (left: number) => {
      track.scrollLeft = left;
      await act(async () => track.dispatchEvent(new Event('scroll')));
    };

    // Told its size, as the browser tells it, the track is aligned for it.
    await click(button('Next slide'));
    await click(button('Previous slide'));
    await scrollTo(0);
    expect(large()?.title).toBe('Plan, slide 1');

    // Past the middle of the way to the next, that one is in view, in the row and the count too.
    await scrollTo(230);
    expect(large()?.title).toBe('Plan, slide 2');
    expect(button('Slide 2')?.getAttribute('aria-current')).toBe('true');
    expect(drawer()?.textContent).toContain('2 / 3');
    await scrollTo(800);
    expect(large()?.title).toBe('Plan, slide 3');
    await scrollTo(390);
    expect(large()?.title).toBe('Plan, slide 2');
  });

  it('edits the slide in view, and keeps which one it was', async () => {
    const api = await opened(deck);
    await click(button('Slide 2'));
    await click(button('Edit'));

    // Only the slide in view opens for editing, and it stays in view until Done.
    expect(frames().filter((item) => item.src.includes('?edit=1'))).toEqual([large()]);
    expect(button('Slide 1')?.disabled).toBe(true);
    expect(button('Next slide')?.disabled).toBe(true);
    // Present is in the toolbar, which Done replaces while a slide is open.
    expect(button('Present')).toBeUndefined();
    const { element, sent } = await loaded(large());
    expect(sent).toHaveBeenCalledWith(
      { jianArtifact: SLIDES[1], jianArtifactEdit: { scale: 1 } },
      '*',
    );

    vi.useFakeTimers();
    await answer(element.contentWindow, { changed: true });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    const edited = (SLIDES[1] as string).replace('Two', 'Second');
    await answer(element.contentWindow, { collect: asked(sent), html: edited });
    vi.useRealTimers();

    expect(api.editSessionArtifact).toHaveBeenCalledWith('profile', 'session', deck.id, {
      version: 1,
      content: edited,
      slide: 2,
      editKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('is presented in the gateway’s own player, and ends when the player says so', async () => {
    await opened(deck);
    expect(presented()).toBeNull();

    await click(button('Present'));
    await settled(() => Boolean(presented()));
    // The player the public link runs, sealed like any Artifact's frame.
    const player = presented()?.querySelector('iframe') as HTMLIFrameElement;
    expect(player.getAttribute('sandbox')).toBe('allow-scripts');
    expect(player.getAttribute('src')).toMatch(
      /\/v1\/artifact-frames\/deck\?present=1&theme=dark$/,
    );
    // Nothing of the old panel-only player is drawn.
    expect(presented()?.querySelectorAll('iframe')).toHaveLength(1);

    const say = (source: unknown, data: unknown) =>
      act(async () => {
        dispatchEvent(new MessageEvent('message', { source: source as Window, data }));
      });
    // A message from anyone but the player's frame ends nothing.
    await say(window, { [ARTIFACT_PRESENT_MESSAGE]: 'end' });
    expect(presented()).not.toBeNull();
    await say(player.contentWindow, { [ARTIFACT_PRESENT_MESSAGE]: 'end' });
    await settled(() => !presented());
    expect(drawer()).not.toBeNull();
  });

  it('ends at Escape without closing the Inspector under it', async () => {
    await opened(deck);
    await click(button('Present'));
    await settled(() => Boolean(presented()));
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settled(() => !presented());
    expect(drawer()).not.toBeNull();
  });

  it('is taken away as a file the gateway draws, or as the page of the slide in view', async () => {
    // What the browser was handed to save: each file's name, type and text.
    const saved: string[] = [];
    let made: Blob | undefined;
    const address = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      made = blob as Blob;
      return 'blob:deck';
    });
    const taken = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      const file = made as Blob;
      void file.text().then((text) => saved.push(`${this.download} ${file.type} ${text}`));
    });
    const api = await opened(deck);
    await click(button('Slide 2'));
    const pick = async (name: string) => {
      const files = saved.length;
      await click((await menu('Download')).find((entry) => entry.textContent === name));
      await settled(() => saved.length > files);
    };

    expect((await menu('Download')).map((entry) => entry.textContent)).toEqual([
      'PDF (.pdf)',
      'Web page (.html)',
      'Current slide as an image (.png)',
      'PowerPoint, current fonts (.pptx)',
      'PowerPoint, basic fonts (.pptx)',
    ]);
    const popup = entries()[0]?.parentElement as HTMLElement;
    // The two PowerPoint files stand apart, under a line, with what tells them apart said last.
    expect(popup.querySelectorAll('[role=separator]')).toHaveLength(1);
    expect(popup.lastElementChild?.textContent).toBe('Basic fonts work on any computer');
    await click(entries()[1]);
    await settled(() => saved.length === 1);
    // The page is the panel's own to save: the gateway is asked for nothing.
    expect(api.exportSessionArtifact).not.toHaveBeenCalled();

    await pick('PDF (.pdf)');
    await pick('Current slide as an image (.png)');
    await pick('PowerPoint, current fonts (.pptx)');
    await pick('PowerPoint, basic fonts (.pptx)');
    expect(api.exportSessionArtifact.mock.calls.map((call) => call.slice(2))).toEqual([
      [deck.id, 1, { format: 'pdf' }],
      [deck.id, 1, { format: 'png', slide: 2 }],
      [deck.id, 1, { format: 'pptx' }],
      [deck.id, 1, { format: 'pptx', fonts: 'basic' }],
    ]);
    expect(saved).toEqual([
      `Plan-v1-slide-2.html text/plain;charset=utf-8 ${SLIDES[1]}`,
      'Plan-v1.pdf test/pdf drawn as pdf',
      'Plan-v1-slide-2.png test/png drawn as png',
      'Plan-v1.pptx test/pptx drawn as pptx',
      'Plan-v1.basic-fonts.pptx test/pptx drawn as pptx',
    ]);
    // Its files are in that menu alone; the options still copy the slide.
    expect((await menu('Artifact options')).map((entry) => entry.textContent)).toEqual([
      'Copy source',
    ]);

    // A deck the gateway could not draw saves nothing, and the menu is there to try again.
    api.exportSessionArtifact.mockRejectedValueOnce(new Error('The deck could not be drawn.'));
    await click(button('Artifact options'));
    await click((await menu('Download'))[0]);
    await settled(() => button('Download')?.disabled === false);
    expect(saved).toHaveLength(5);
    expect(button('Download')?.disabled).toBe(false);
    address.mockRestore();
    taken.mockRestore();
  });

  it('offers only the page on the gateway a desktop app runs, which draws no deck', async () => {
    await opened(deck, gateway(), 'local');

    expect((await menu('Download')).map((entry) => entry.textContent)).toEqual([
      'Web page (.html)',
    ]);
    expect(document.body.textContent).not.toContain('Basic fonts');
  });

  it('leaves every other Artifact its one download, behind the options', async () => {
    await opened(page);

    expect(button('Download')).toBeUndefined();
    expect((await menu('Artifact options')).map((entry) => entry.textContent)).toEqual([
      'Copy source',
      'Download',
    ]);
  });
});

describe('a Document and a spreadsheet as files', () => {
  it('offers Word, PDF and Markdown, and Excel and CSV, from one Download menu', async () => {
    const saved: string[] = [];
    const address = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file');
    const taken = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    const api = await opened(notes);

    expect((await menu('Download')).map((entry) => entry.textContent)).toEqual([
      'Word (.docx)',
      'PDF (.pdf)',
      'Markdown (.md)',
    ]);
    await click(entries()[0]);
    await settled(() => saved.length === 1);
    expect(api.exportSessionArtifact.mock.calls[0]?.slice(2)).toEqual([
      notes.id,
      3,
      { format: 'docx' },
    ]);
    expect(saved).toEqual(['Launch-notes-v3.docx']);
    // Only the Document's PDF needs the gateway's browser; the Markdown is the panel's own.
    await click((await menu('Download'))[2]);
    await settled(() => saved.length === 2);
    expect(saved[1]).toBe('Launch-notes-v3.md');
    expect(api.exportSessionArtifact).toHaveBeenCalledTimes(1);
    address.mockRestore();
    taken.mockRestore();
  });

  it('leaves out the PDF on the gateway a desktop app runs', async () => {
    await opened(notes, gateway(), 'local');
    expect((await menu('Download')).map((entry) => entry.textContent)).toEqual([
      'Word (.docx)',
      'Markdown (.md)',
    ]);
  });

  it('gives a spreadsheet Excel and CSV', async () => {
    const api = await opened(sheet, gateway([sheet]));

    expect((await menu('Download')).map((entry) => entry.textContent)).toEqual([
      'Excel (.xlsx)',
      'CSV, values (.csv)',
    ]);
    expect(api.exportSessionArtifact).not.toHaveBeenCalled();
  });
});

describe('what a frame answers when asked for an edit', () => {
  const said = (answer: unknown) => ({ jianArtifactEdit: answer });

  it('is read only as the answer to the question that was asked', () => {
    expect(editAnswer(said({ collect: 'word', html: '<p>Hi</p>' }), 'word')).toEqual({
      html: '<p>Hi</p>',
    });
    expect(editAnswer(said({ collect: 'word', unchanged: true }), 'word')).toEqual({
      unchanged: true,
    });

    for (const stray of [
      null,
      undefined,
      'text',
      42,
      [],
      {},
      { jianArtifact: '<p>Hi</p>' },
      said(null),
      said('word'),
      said({ html: '<p>Hi</p>' }),
      said({ collect: 'another', html: '<p>Hi</p>' }),
      said({ collect: 1, html: '<p>Hi</p>' }),
    ]) {
      expect(editAnswer(stray, 'word')).toBeUndefined();
    }
  });

  it('refuses markup that is not text, is empty, or is more than a page holds', () => {
    for (const html of [undefined, null, 42, {}, ['<p>Hi</p>'], '', '  \n']) {
      expect(editAnswer(said({ collect: 'word', html }), 'word')).toHaveProperty('refused');
    }
    const most = 'x'.repeat(SESSION_ARTIFACT_MAX);
    expect(editAnswer(said({ collect: 'word', html: most }), 'word')).toEqual({ html: most });
    expect(editAnswer(said({ collect: 'word', html: `${most}x` }), 'word')).toMatchObject({
      refused: expect.stringMatching(/too large/),
    });
  });

  it('gives up on a frame that is not there, or does not answer', async () => {
    const heard = vi.spyOn(window, 'addEventListener');
    const unheard = vi.spyOn(window, 'removeEventListener');
    const quiet = { contentWindow: { postMessage: vi.fn() } } as unknown as HTMLIFrameElement;

    await expect(collectEdit(null)).rejects.toThrow(/not open for editing/);
    await expect(collectEdit(quiet, 20)).rejects.toThrow(/did not answer/);
    // Nothing is left listening after it gave up.
    expect(listening(heard)).toBe(1);
    expect(listening(unheard)).toBe(1);
    heard.mockRestore();
    unheard.mockRestore();
  });
});

describe('the file a version downloads as', () => {
  it('is named after the Artifact, its version and its type', () => {
    expect(fileName({ title: 'Q3 plan: très bien!', type: 'markdown' }, 2)).toBe(
      'Q3-plan-très-bien-v2.md',
    );
    expect(fileName({ title: '../../etc/passwd', type: 'html' }, 1)).toBe('etc-passwd-v1.html');
    expect(fileName({ title: '???', type: 'react' }, 1)).toBe('artifact-v1.tsx');
    // A deck's page is one slide's; drawn into another kind of file, it is named as that.
    expect(fileName({ title: 'Plan', type: 'deck' }, 4, 2)).toBe('Plan-v4-slide-2.html');
    expect(fileName({ title: 'Plan', type: 'deck' }, 4, undefined, 'pdf')).toBe('Plan-v4.pdf');
  });
});

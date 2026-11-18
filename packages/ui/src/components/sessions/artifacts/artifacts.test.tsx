import { SESSION_ARTIFACT_MAX } from '@jian/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionArtifact } from '../../../lib/api';
import { publish } from '../../../lib/events';
import { keys } from '../../../lib/query/keys';
import { useCrew } from '../../../lib/stores/crew';
import { focusInspector } from '../inspector-host';
import { ArtifactsDrawer } from './artifacts-drawer';
import { collectEdit, editAnswer } from './edit';
import { fileName } from './source';
import type { ArtifactsApi } from './use-artifacts';

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

function gateway(artifacts: SessionArtifact[] = [counter, notes, page, deck]) {
  const held = [...artifacts];

  return {
    held,
    // None of these is a file: the files have a test of their own (artifact-files.test.tsx).
    media: vi.fn(async (): Promise<never> => {
      throw new Error('Media not found');
    }),
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
        wanted: { format: 'pdf' | 'png' | 'pptx'; slide?: number; fonts?: 'current' | 'basic' },
      ) => ({ mimeType: `test/${wanted.format}`, data: btoa(`drawn as ${wanted.format}`) }),
    ),
    editSessionArtifact: vi.fn(
      async (
        _profile: string,
        _session: string,
        artifactId: string,
        _edit: { version: number; content: string; slide?: number },
      ) => {
        const index = held.findIndex((item) => item.id === artifactId);
        const current = held[index] as SessionArtifact;
        const next: SessionArtifact = { ...current, version: current.version + 1 };
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
  } satisfies ArtifactsApi & { held: SessionArtifact[] };
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
});

async function settled(done: () => boolean, limit = 100) {
  for (let tries = 0; tries < limit && !done(); tries += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

async function render(api: ArtifactsApi, mode: 'server' | 'local' = 'server') {
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

describe('the Artifacts tab', () => {
  it('lists what the agent made, and opens one', async () => {
    const api = gateway();
    await act(async () => useCrew.getState().showArtifacts());
    await render(api);
    await settled(() => Boolean(drawer()?.querySelector('li')));

    expect([...(drawer()?.querySelectorAll('li') ?? [])].map((row) => row.textContent)).toEqual([
      'CounterReact component · Version 1',
      'Launch notesDocument · Version 3',
      'LandingWeb page · Version 2',
      'PlanDeck · Version 1',
    ]);
    expect(frame()).toBeNull();

    await click(drawer()?.querySelectorAll('li button')[1]);
    await settled(() => Boolean(frame()));

    expect(drawer()?.querySelector('h2')?.textContent).toBe('Launch notes');
    expect(viewed(api)).toBe(3);

    await click(button('All artifacts'));
    expect(frame()).toBeNull();
    expect(drawer()?.querySelectorAll('li')).toHaveLength(4);
  });

  it('says so when the conversation has none', async () => {
    await act(async () => useCrew.getState().showArtifacts());
    await render(gateway([]));
    await settled(() => !drawer()?.querySelector('[role=status]'));

    expect(drawer()?.textContent).toContain('Nothing here yet');
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
    expect(frame()?.getAttribute('src')).toBe(`${window.location.origin}/v1/artifact-frames/react`);
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

describe('editing one by hand', () => {
  it('is offered for a page and a deck, and for nothing else', async () => {
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
  });

  it('opens the page in the frame that edits, as sealed as the one that draws', async () => {
    await opened(page);
    await click(button('Edit'));

    expect(frame()?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame()?.getAttribute('src')).toBe(
      `${window.location.origin}/v1/artifact-frames/html?edit=1`,
    );
    expect(frame()?.getAttribute('src')).not.toContain(page.id);
    const { sent } = await loaded();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith({ jianArtifact: PAGE, jianArtifactEdit: { scale: 1 } }, '*');
    // The version is held while it is edited: there is no picking another.
    expect(button('History')).toBeUndefined();

    await click(named('Cancel'));
    expect(frame()?.getAttribute('src')).toBe(`${window.location.origin}/v1/artifact-frames/html`);
    expect(button('History')).toBeDefined();
  });

  it('saves what that frame answers, and no one else, as a new version', async () => {
    const heard = vi.spyOn(window, 'addEventListener');
    const unheard = vi.spyOn(window, 'removeEventListener');
    const api = await opened(page);
    await click(button('Edit'));
    const { element, sent } = await loaded();
    // Open for editing, the panel still listens to nothing: only a save asks.
    expect(listening(heard)).toBe(0);

    await click(named('Save'));
    expect(listening(heard)).toBe(1);
    const word = asked(sent);
    expect(word).toMatch(/^[0-9a-f-]{36}$/);
    const edited = PAGE.replace('Launch', 'Launched');

    // Another window with the right word, and the frame with a wrong one: neither is heard.
    await answer(window, { collect: word, html: '<p>From elsewhere</p>' });
    await answer({ postMessage: vi.fn() }, { collect: word, html: '<p>From another frame</p>' });
    await answer(element.contentWindow, { collect: 'a-guess', html: '<p>Guessed</p>' });
    expect(api.editSessionArtifact).not.toHaveBeenCalled();

    await answer(element.contentWindow, { collect: word, html: edited });
    await settled(() => viewed(api) === 3);
    expect(api.editSessionArtifact).toHaveBeenCalledTimes(1);
    expect(api.editSessionArtifact).toHaveBeenCalledWith('profile', 'session', page.id, {
      version: 2,
      content: edited,
    });
    // It stopped listening the moment it had its answer, and shows the new version drawn.
    expect(listening(unheard)).toBe(1);
    expect(viewed(api)).toBe(3);
    expect(older()).toBeUndefined();
    await settled(() => Boolean(frame()));
    expect(frame()?.getAttribute('src')).toBe(`${window.location.origin}/v1/artifact-frames/html`);

    // Said again, the same answer is nobody's: no second version.
    await answer(element.contentWindow, { collect: word, html: '<p>Again</p>' });
    expect(api.editSessionArtifact).toHaveBeenCalledTimes(1);
    heard.mockRestore();
    unheard.mockRestore();
  });

  it('keeps nothing when nothing was edited, or when the answer cannot be kept', async () => {
    const api = await opened(page);

    await click(button('Edit'));
    const untouched = await loaded();
    await click(named('Save'));
    await answer(untouched.element.contentWindow, {
      collect: asked(untouched.sent),
      unchanged: true,
    });
    await settled(() => !named('Save'));
    expect(named('Save')).toBeUndefined();

    await click(button('Edit'));
    const huge = await loaded();
    await click(named('Save'));
    await answer(huge.element.contentWindow, {
      collect: asked(huge.sent),
      html: 'x'.repeat(SESSION_ARTIFACT_MAX + 1),
    });
    await settled(() => named('Save')?.disabled === false);
    // The edit stays open, so nothing typed is lost to a save that was refused.
    expect(named('Save')).toBeDefined();
    expect(frame()?.getAttribute('src')).toContain('?edit=1');

    expect(api.editSessionArtifact).not.toHaveBeenCalled();
    expect(viewed(api)).toBe(2);
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
      expect(item.getAttribute('src')).toBe(`${window.location.origin}/v1/artifact-frames/deck`);
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

  it('edits the slide in view, and says which when it saves', async () => {
    const api = await opened(deck);
    await click(button('Slide 2'));
    await click(button('Edit'));

    // Only the slide in view opens for editing, and it stays in view until saved or cancelled.
    expect(frames().filter((item) => item.src.endsWith('?edit=1'))).toEqual([large()]);
    expect(button('Slide 1')?.disabled).toBe(true);
    expect(button('Next slide')?.disabled).toBe(true);
    // Present is in the toolbar, which Save and Cancel replace while a slide is open.
    expect(button('Present')).toBeUndefined();
    const { element, sent } = await loaded(large());
    expect(sent).toHaveBeenCalledWith(
      { jianArtifact: SLIDES[1], jianArtifactEdit: { scale: 1 } },
      '*',
    );

    await click(named('Save'));
    const edited = (SLIDES[1] as string).replace('Two', 'Second');
    await answer(element.contentWindow, { collect: asked(sent), html: edited });
    await settled(() => viewed(api) === 2);

    expect(api.editSessionArtifact).toHaveBeenCalledWith('profile', 'session', deck.id, {
      version: 1,
      content: edited,
      slide: 2,
    });
    expect(viewed(api)).toBe(2);
  });

  it('is presented over the whole window, and comes back to the slide it ended on', async () => {
    await opened(deck);
    expect(presented()).toBeNull();

    await click(button('Present'));
    await settled(() => Boolean(presented()));
    // The slide on top: the one it came from stays drawn under it.
    const shown = () => [...(presented()?.querySelectorAll('iframe') ?? [])].at(-1);
    expect(shown()?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(shown()?.title).toBe('Slide 1 of 3');

    const press = (key: string) =>
      act(async () => {
        presented()?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    await press('ArrowRight');
    expect(shown()?.title).toBe('Slide 2 of 3');
    await press('End');
    await press('ArrowRight');
    expect(shown()?.title).toBe('Slide 3 of 3');

    // Escape ends the presentation and stops there: the Inspector stays open under it.
    await press('Escape');
    await settled(() => !presented());
    expect(presented()).toBeNull();
    expect(drawer()).not.toBeNull();
    expect(large()?.title).toBe('Plan, slide 3');
  });

  const entries = () => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
  const menu = async (label: string) => {
    await settled(() => entries().length === 0);
    await click(button(label));
    await settled(() => entries().length > 0);
    return entries();
  };

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

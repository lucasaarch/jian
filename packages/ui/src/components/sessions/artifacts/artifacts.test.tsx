import { ARTIFACT_PRESENT_MESSAGE, type PanelUsage, SESSION_ARTIFACT_MAX } from '@jian/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeckExportQuery, DeckSlidesEdit, SessionArtifact } from '../../../lib/api';
import { publish } from '../../../lib/events';
import { keys } from '../../../lib/query/keys';
import { useArtifactDraft } from '../../../lib/stores/artifact-draft';
import { useCrew } from '../../../lib/stores/crew';
import { draftKey, useDrafts } from '../../../lib/stores/drafts';
import { flushUsage, setUsageReporting } from '../../../lib/usage';
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
  passwordProtected: false,
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
  // The deck's slides by version, as the gateway keeps them.
  const decks = new Map<number, string[]>([[1, SLIDES]]);

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
                ? JSON.stringify({ slides: decks.get(version) ?? SLIDES })
                : `# Notes, version ${version}`,
        ...(artifactId === counter.id ? { compiled: COMPILED } : {}),
        ...(artifactId === deck.id ? { slides: decks.get(version) ?? SLIDES } : {}),
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
    editDeckSlides: vi.fn(
      async (_profile: string, _session: string, artifactId: string, change: DeckSlidesEdit) => {
        const index = held.findIndex((item) => item.id === artifactId);
        const current = held[index] as SessionArtifact;
        const slides = [...(decks.get(change.version) ?? SLIDES)];
        if (change.op === 'add') {
          slides.splice((change.position ?? slides.length + 1) - 1, 0, change.html);
        }
        if (change.op === 'delete') slides.splice(change.slide - 1, 1);
        const next: SessionArtifact = { ...current, version: current.version + 1 };
        held[index] = next;
        decks.set(next.version, slides);
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
    setSessionArtifactPassword: vi.fn(
      async (_profile: string, _session: string, artifactId: string, password: string | null) => {
        const index = held.findIndex((item) => item.id === artifactId);
        const next: SessionArtifact = {
          ...(held[index] as SessionArtifact),
          passwordProtected: password !== null,
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

async function render(
  api: ArtifactsDrawerApi,
  mode: 'server' | 'local' = 'server',
  ask?: (text: string) => void,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // What kind of gateway this is, as its health answer said.
  client.setQueryData(keys.gateway, { status: 'ok', mode });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ArtifactsDrawer api={api} profileId="profile" ask={ask} />
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

  it('shows a Mermaid diagram and a diagram as one kind, Diagram', async () => {
    const flow: SessionArtifact = {
      ...counter,
      id: '66666666-6666-4666-8666-666666666666',
      title: 'Flow',
      type: 'mermaid',
    };
    const map: SessionArtifact = {
      ...counter,
      id: '77777777-7777-4777-8777-777777777777',
      title: 'Map',
      type: 'diagram',
    };
    await listed(gateway([flow, map, notes]));

    await click(button('Type'));
    await settled(() => document.querySelectorAll('[role="option"]').length > 0);
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.filter((item) => item.textContent?.includes('Diagram'))).toHaveLength(1);
    await click(options.find((item) => item.textContent?.includes('Diagram')));
    expect(cards()).toEqual(['Flow', 'Map']);
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

  it('is never listened to by the panel, but for a component’s tweaks', async () => {
    const heard = vi.spyOn(window, 'addEventListener');

    await opened(page);
    await loaded();

    expect(heard.mock.calls.filter(([type]) => type === 'message')).toEqual([]);
    heard.mockRestore();
  });

  it('draws the tweaks a component says, from its own frame only, and sends their values', async () => {
    await opened(counter);
    const { element, sent } = await loaded();
    const tweaks = () => drawer()?.querySelector('aside[aria-label="Tweaks"]');
    const say = (source: unknown, controls: unknown) =>
      act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { jianArtifactTweaks: { controls } },
            source: source as MessageEventSource,
          }),
        );
      });
    const values = () =>
      sent.mock.calls.filter(([said]) => said.jianArtifactTweaks).at(-1)?.[0].jianArtifactTweaks;

    // Another window saying it is heard as nothing at all.
    await say({ postMessage: vi.fn() }, { label: 'Count' });
    expect(tweaks()).toBeNull();

    // From its own frame: drawn, open by itself, a tweak that does not fit left out, and the
    // component sent every value shown.
    await say(element.contentWindow, {
      label: 'Count',
      size: { type: 'number', min: 8, max: 64, default: 16 },
      'not a prop': true,
      __proto__x: { type: 'nothing' },
    });
    expect(tweaks()?.querySelector('input:not([type])')).toHaveProperty('value', 'Count');
    expect(tweaks()?.textContent).toContain('Size');
    expect(tweaks()?.textContent).not.toContain('not a prop');
    expect(values()).toEqual({ values: { label: 'Count', size: 16 } });

    const field = tweaks()?.querySelector('input:not([type])') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      set?.call(field, 'Clicks');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(values()).toEqual({ values: { label: 'Clicks', size: 16 } });

    // The theme it is tried in goes to its frame alone, as the panel's own would.
    await click(
      [...(tweaks()?.querySelectorAll('button') ?? [])].find(
        (item) => item.textContent === 'Light',
      ),
    );
    expect(sent).toHaveBeenCalledWith({ jianArtifactTheme: 'light' }, '*');

    // Drawn anew, it keeps what the owner set for a tweak that still takes it.
    await say(element.contentWindow, { label: 'Count', size: 'large' });
    expect(values()).toEqual({ values: { label: 'Clicks', size: 'large' } });

    await click(button('Tweaks'));
    expect(tweaks()).toBeNull();
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
    expect(entries().map((entry) => entry.textContent)).toEqual([
      'Copy source',
      'Copy prompt for',
      'Download',
    ]);
  });

  it('copies a component as a prompt for another framework, with its source as written', async () => {
    const copied = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: copied },
      configurable: true,
    });
    await opened(counter, gateway(), 'local');

    await click(button('Artifact options'));
    await settled(() => entries().length > 0);
    await click(entries().find((entry) => entry.textContent === 'Copy prompt for'));
    await settled(() => entries().some((entry) => entry.textContent === 'Vue 3'));
    await click(entries().find((entry) => entry.textContent === 'Vue 3'));

    const prompt = String(copied.mock.calls.at(-1)?.[0]);
    expect(prompt).toMatch(/^# Counter\n/);
    expect(prompt).toContain('Vue 3 single-file component');
    expect(prompt).toContain(SOURCE);
    expect(prompt).not.toContain(COMPILED);
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

  it('gives a public link a password, changes it and takes it away', async () => {
    const shared: SessionArtifact = {
      ...counter,
      visibility: 'public',
      publicPath: `/v1/public-artifacts/${'A'.repeat(43)}`,
    };
    const api = await opened(shared, gateway([shared, notes, page, deck]), 'server');
    const dialog = () => document.querySelector<HTMLElement>('[role=dialog]');
    const input = () => dialog()?.querySelector<HTMLInputElement>('input[type=password]');
    const save = () =>
      [...(dialog()?.querySelectorAll('button') ?? [])].find((item) => item.textContent === 'Save');
    const type = (value: string) =>
      act(async () => {
        const field = input();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          field,
          value,
        );
        field?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const choose = async (words: string) => {
      await click(button('Public'));
      await settled(() => entries().some((entry) => entry.textContent === words));
      await click(entries().find((entry) => entry.textContent === words));
    };

    await choose('Add password');
    await settled(() => Boolean(input()));
    // Too short to keep: Save waits for four characters.
    await type('abc');
    expect(save()?.disabled).toBe(true);
    await type('open sesame');
    await act(async () => save()?.click());
    await settled(() => !dialog());
    expect(api.setSessionArtifactPassword).toHaveBeenCalledWith(
      'profile',
      'session',
      counter.id,
      'open sesame',
    );
    expect(button('Public with a password')).toBeDefined();

    await choose('Change password');
    await settled(() => Boolean(input()));
    expect(dialog()?.textContent).toContain('Change password');
    await click(
      [...(dialog()?.querySelectorAll('button') ?? [])].find(
        (item) => item.textContent === 'Cancel',
      ),
    );
    await settled(() => !dialog());

    await choose('Remove password');
    await settled(() => button('Public: anyone') !== undefined);
    expect(api.setSessionArtifactPassword).toHaveBeenLastCalledWith(
      'profile',
      'session',
      counter.id,
      null,
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
    await settled(() => frame()?.getAttribute('src')?.includes('?edit=1') === true);
    expect(frame()?.getAttribute('src')).toBe(
      `${window.location.origin}/v1/artifact-frames/markdown?edit=1&theme=dark`,
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

  it('never shows what is half written of a page as code, nor runs it', async () => {
    await render(gateway([]));

    await told(writing('<h1>Hi</h1><script>alert(1)</script>', { type: 'html' }));
    expect(drawer()?.textContent).toContain('Generating…');
    expect(drawer()?.textContent).not.toContain('<h1>Hi');
    expect(drawer()?.querySelector('pre')).toBeNull();
    expect(frame()).toBeNull();
  });

  it('fills a spreadsheet in cell by cell, as text, with the cell being written marked', async () => {
    await render(gateway([]));

    await told(writing('Item,Cost\nA,2\n"<b>B</b>, quoted",=SU', { type: 'sheet' }));
    const cells = () => [...(drawer()?.querySelectorAll('tbody td') ?? [])];
    expect(cells().map((cell) => cell.textContent)).toEqual([
      'Item',
      'Cost',
      'A',
      '2',
      '<b>B</b>, quoted',
      '=SU',
    ]);
    // Data, never markup: what looks like a tag is the cell's own text.
    expect(drawer()?.querySelector('tbody b')).toBeNull();
    expect(drawer()?.querySelector('[data-writing]')?.textContent).toBe('=SU');

    await told(writing('Item,Cost,Paid\nA,2,yes\n', { type: 'sheet' }));
    expect(drawer()?.querySelectorAll('thead th[scope=col]')).toHaveLength(3);
    expect(drawer()?.querySelector('[data-writing]')).toBeNull();
  });

  it('draws the slides of a deck as each is finished, and none half written', async () => {
    await render(gateway([]));

    const slide = (text: string) => `<!doctype html><h1>${text}</h1>`;
    await told(
      writing(`${slide('One')}\n\n${slide('Tw')}`, {
        type: 'deck',
        slides: [slide('One')],
      }),
    );
    expect(container.querySelectorAll('ol[aria-label="Slides"] iframe')).toHaveLength(1);
    expect(drawer()?.querySelector('[aria-label="Slide 2, being written"]')).not.toBeNull();

    await told(
      writing(`${slide('One')}\n\n${slide('Two')}`, {
        type: 'deck',
        slides: [slide('One'), slide('Two')],
      }),
    );
    expect(container.querySelectorAll('ol[aria-label="Slides"] iframe')).toHaveLength(2);
  });

  it('keeps the current version in view while the agent changes it, with Updating…', async () => {
    const api = gateway();
    await opened(notes, api);
    await settled(() => drawer()?.querySelector('h2')?.textContent === notes.title);

    // Named but not yet written: the version stays, with the quiet word beside it.
    await told(writing('', { artifactId: notes.id }));
    expect(frame()).not.toBeNull();
    expect(drawer()?.textContent).toContain('Updating…');

    // Written again whole, a document still keeps its version in view, the owner's edits with it.
    const before = frame();
    await told(writing('# New words', { artifactId: notes.id }));
    expect(frame()).toBe(before);
    expect(drawer()?.querySelector('article')).toBeNull();

    api.held[api.held.findIndex((item) => item.id === notes.id)] = { ...notes, version: 4 };
    await told(undefined);
    await settled(() => viewed(api) === 4);
    expect(viewed(api)).toBe(4);
    expect(drawer()?.textContent).not.toContain('Updating…');
  });

  it('fills a spreadsheet written again whole where it stands', async () => {
    await opened(sheet, gateway([sheet]));
    await settled(() => drawer()?.querySelector('h2')?.textContent === sheet.title);

    await told(writing('Item,Cost\nA,3', { artifactId: sheet.id, type: undefined }));
    expect(frame()).toBeNull();
    expect(drawer()?.querySelector('[data-writing]')?.textContent).toBe('3');
    expect(drawer()?.textContent).toContain('Updating…');
  });

  it('moves no focus when it opens the tab by itself', async () => {
    await listed();
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();

    // The tab opens on it by itself, as the agent's own request to show one does.
    await told(writing('', { artifactId: notes.id }));
    expect(document.activeElement).toBe(composer);
    expect(drawer()?.textContent).toContain('Updating…');
    composer.remove();
  });
});

describe('an Artifact that fails as it runs', () => {
  const failing = async () => {
    const ask = vi.fn();
    await act(async () => useCrew.getState().showArtifacts(counter.id));
    await render(gateway(), 'server', ask);
    await settled(() => Boolean(frame()));
    const { element } = await loaded();
    const say = (source: unknown, said: unknown) =>
      act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { jianArtifactError: said },
            source: source as MessageEventSource,
          }),
        );
      });
    return { ask, element, say };
  };
  // The badge in the Artifact's corner, and the dialog it opens.
  const badge = () =>
    [...(drawer()?.querySelectorAll<HTMLButtonElement>('button[aria-haspopup=dialog]') ?? [])].find(
      (item) => /error|Fix asked/.test(item.textContent ?? ''),
    );
  const dialog = () => document.querySelector<HTMLElement>('[role=dialog]');
  const action = (name: string) =>
    [...(dialog()?.querySelectorAll('button') ?? [])].find((item) => item.textContent === name);

  it('says what its frame reported, as text, and Fix asks the agent with all of it', async () => {
    const { ask, element, say } = await failing();

    // Another window saying it is heard as nothing at all, and so is a shape it does not have.
    await say({ postMessage: vi.fn() }, { message: 'Not mine' });
    await say(element.contentWindow, { message: 42 });
    expect(badge()).toBeFalsy();

    await say(element.contentWindow, {
      message: 'TypeError: <b>items</b>.map is not a function',
      componentStack: 'at List\nat App',
      stack: 'at List (about:srcdoc:3:9)',
    });
    // Small in the corner: the error itself waits in the dialog it opens.
    expect(badge()?.textContent).toBe('Component error');
    expect(dialog()).toBeNull();
    await click(badge());
    expect(dialog()?.textContent).toContain('The component failed');
    expect(dialog()?.textContent).toContain('<b>items</b>.map is not a function');
    expect(dialog()?.textContent).toContain('at List\nat App');
    expect(dialog()?.querySelector('b')).toBeNull();

    // Only the first is said: what follows from it repeats it.
    await say(element.contentWindow, { message: 'Error: later' });
    expect(dialog()?.textContent).not.toContain('later');

    await click(action('Fix'));
    expect(ask).toHaveBeenCalledTimes(1);
    const [text] = ask.mock.calls[0] as [string];
    expect(text).toContain(counter.id);
    expect(text).toContain(`version ${counter.version}`);
    expect(text).toContain('<b>items</b>.map is not a function');
    expect(text).toContain('at List\nat App');
    expect(text).toContain('about:srcdoc:3:9');
    // Asked once: the dialog closes, the badge says so, and Fix holds until the fixed version.
    await settled(() => !dialog());
    expect(badge()?.textContent).toBe('Fix asked');
    await click(badge());
    expect(action('Asked to fix')?.hasAttribute('disabled')).toBe(true);
  });

  it('holds Fix while the agent is already changing it', async () => {
    const { ask, element, say } = await failing();
    await say(element.contentWindow, { message: 'Error: broken' });
    await act(async () =>
      hearArtifactDraft('session', { toolCallId: 'call', artifactId: counter.id, content: '' }),
    );

    await click(badge());
    expect(dialog()?.textContent).toContain('The agent is changing it now.');
    expect(action('Fix')?.hasAttribute('disabled')).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('counts Fix pressed, and nothing of what failed, for the anonymous report', async () => {
    setUsageReporting(false);
    setUsageReporting(true);
    const { element, say } = await failing();
    await say(element.contentWindow, { message: 'Error: the Acme total is broken' });
    await click(badge());
    await click(action('Fix'));

    const send = vi.fn(async (_usage: PanelUsage) => undefined);
    await flushUsage(send);
    setUsageReporting(undefined);

    expect(send).toHaveBeenCalledWith({
      host: 'web',
      phone: false,
      counts: { artifact_opened_react: 1, artifact_fix_pressed: 1 },
    });
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
    ).toEqual(['Slide 1', 'Slide 2', 'Slide 3', 'New slide']);
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

    // Only the slide in view opens for editing, with what builds on it beside Done.
    expect(frames().filter((item) => item.src.includes('?edit=1'))).toEqual([large()]);
    expect(button('Add a text box')).toBeDefined();
    expect(button('Add a picture')).toBeDefined();
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

  it('keeps what was typed before going to another slide, and opens that one', async () => {
    const api = await opened(deck);
    await click(button('Edit'));
    const { element, sent } = await loaded(large());
    await changed(element);

    await click(button('Slide 3'));
    await settled(() => questions(sent) > 0);
    // Nothing moves until the edit is kept.
    expect(large()?.title).toBe('Plan, slide 1, editing');
    const edited = (SLIDES[0] as string).replace('One', 'First');
    await answer(element.contentWindow, { collect: asked(sent), html: edited });
    await settled(() => large()?.title === 'Plan, slide 3, editing');

    expect(api.editSessionArtifact).toHaveBeenCalledWith('profile', 'session', deck.id, {
      version: 1,
      content: edited,
      slide: 1,
      editKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(large()?.src).toContain('?edit=1');
    expect(button('Slide 3')?.getAttribute('aria-current')).toBe('true');
  });

  /** The rail's slides, by name, without its other buttons. */
  const railed = () =>
    [
      ...(drawer()?.querySelectorAll('nav[aria-label=Slides] button[aria-label^="Slide "]') ?? []),
    ].map((item) => item.getAttribute('aria-label'));

  it('adds a slide after the one in view, from a layout in the deck’s look', async () => {
    const api = await opened(deck);
    await click(button('Slide 2'));

    const layouts = await menu('New slide');
    expect(layouts.map((entry) => entry.textContent)).toEqual([
      'Title',
      'Title and text',
      'Two columns',
      'Section header',
      'Blank',
      'Duplicate current',
    ]);
    await click(layouts.find((entry) => entry.textContent === 'Title and text'));
    await settled(() => railed().length === 4);

    expect(api.editDeckSlides).toHaveBeenCalledWith('profile', 'session', deck.id, {
      op: 'add',
      version: 1,
      position: 3,
      html: expect.stringContaining('Click to add title'),
    });
    // A new slide holds the layout's words to type over, none of the slide it was made from.
    const [, , , change] = api.editDeckSlides.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { html: string },
    ];
    expect(change.html).not.toContain('Two');
    // The new one is in view, in the version it made.
    expect(button('Slide 3')?.getAttribute('aria-current')).toBe('true');
    expect(viewed(api)).toBe(2);
  });

  it('deletes a focused slide with Delete, and gives it back with Undo', async () => {
    const api = await opened(deck);
    const second = button('Slide 2') as HTMLButtonElement;
    await act(async () => {
      second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    await settled(() => railed().length === 2);
    expect(api.editDeckSlides).toHaveBeenCalledWith('profile', 'session', deck.id, {
      op: 'delete',
      version: 1,
      slide: 2,
    });

    const told = vi.mocked(toast).mock.calls.find(([said]) => said === 'Slide 2 deleted.');
    const undo = (told?.[1] as { action: { label: string; onClick: () => void } } | undefined)
      ?.action;
    if (!undo) throw new Error('The owner was not offered Undo.');
    expect(undo.label).toBe('Undo');
    await act(async () => undo.onClick());
    await settled(() => railed().length === 3);
    // The slide as the gateway held it, back where it was.
    expect(api.editDeckSlides).toHaveBeenLastCalledWith('profile', 'session', deck.id, {
      op: 'add',
      version: 2,
      position: 2,
      html: SLIDES[1],
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

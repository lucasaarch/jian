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

function gateway(artifacts: SessionArtifact[] = [counter, notes]) {
  const held = [...artifacts];

  return {
    held,
    sessionArtifacts: vi.fn(async () => [...held]),
    sessionArtifactVersion: vi.fn(
      async (_profile: string, _session: string, artifactId: string, version: number) => ({
        artifactId,
        version,
        content: artifactId === counter.id ? SOURCE : `# Notes, version ${version}`,
        ...(artifactId === counter.id ? { compiled: COMPILED } : {}),
        createdAt: at,
      }),
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
async function loaded() {
  const sent = vi.fn();
  const element = frame() as HTMLIFrameElement;

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

describe('the Artifacts tab', () => {
  it('lists what the agent made, and opens one', async () => {
    await act(async () => useCrew.getState().showArtifacts());
    await render(gateway());
    await settled(() => Boolean(drawer()?.querySelector('li')));

    expect([...(drawer()?.querySelectorAll('li') ?? [])].map((row) => row.textContent)).toEqual([
      'CounterReact component · Version 1',
      'Launch notesDocument · Version 3',
    ]);
    expect(frame()).toBeNull();

    await click(drawer()?.querySelectorAll('li button')[1]);
    await settled(() => Boolean(frame()));

    expect(drawer()?.querySelector('h2')?.textContent).toBe('Launch notes');
    expect(button('Version')?.textContent).toBe('v3');

    await click(button('All artifacts'));
    expect(frame()).toBeNull();
    expect(drawer()?.querySelectorAll('li')).toHaveLength(2);
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
    expect(button('Version')?.textContent).toBe('v3');
    const first = frame();

    api.held[1] = { ...notes, version: 4 };
    await act(async () => publish({ id: 1, type: 'conversation.inspector.focus', data: made }));
    await settled(() => button('Version')?.textContent === 'v4');

    expect(button('Version')?.textContent).toBe('v4');
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
    // Everything else is still there.
    expect(button('Copy source')).toBeDefined();
    expect(button('Download')).toBeDefined();
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

describe('the file a version downloads as', () => {
  it('is named after the Artifact, its version and its type', () => {
    expect(fileName({ title: 'Q3 plan: très bien!', type: 'markdown' }, 2)).toBe(
      'Q3-plan-très-bien-v2.md',
    );
    expect(fileName({ title: '../../etc/passwd', type: 'html' }, 1)).toBe('etc-passwd-v1.html');
    expect(fileName({ title: '???', type: 'react' }, 1)).toBe('artifact-v1.tsx');
  });
});

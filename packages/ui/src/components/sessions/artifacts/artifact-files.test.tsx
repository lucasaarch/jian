import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionArtifact } from '../../../lib/api';
import { keys } from '../../../lib/query/keys';
import { useCrew } from '../../../lib/stores/crew';
import { ArtifactsDrawer } from './artifacts-drawer';
import type { ArtifactsApi } from './use-artifacts';

/** A file as an Artifact: listed by its format, and read by that format's reader, in no frame. */

const at = '2026-11-18T10:00:00.000Z';
const encoded = (text: string) => btoa(text);
const HELD = {
  report: { mimeType: 'application/pdf', name: 'report.pdf', data: encoded('%PDF-1.4 synthetic') },
  guide: {
    mimeType: 'text/markdown',
    name: 'guide.md',
    data: encoded('# Guide\n\n<script>window.reached = true</script>'),
  },
  script: {
    mimeType: 'application/octet-stream',
    name: 'tool.py',
    data: encoded('print("<b>hi</b>")'),
  },
  bundle: { mimeType: 'application/zip', name: 'bundle.zip', data: btoa('PK\u0003\u0004\u0000') },
} as const;
type Name = keyof typeof HELD;

const file = (name: Name, index: number): SessionArtifact => ({
  id: `${index}${index}${index}${index}${index}${index}${index}${index}-1111-4111-8111-111111111111`,
  sessionId: 'session',
  title: name,
  type: 'file',
  visibility: 'private',
  version: 1,
  publicPath: null,
  file: {
    mediaId: name,
    name: HELD[name].name,
    mimeType: HELD[name].mimeType,
    bytes: atob(HELD[name].data).length,
  },
  createdAt: at,
  updatedAt: at,
});
const files = (Object.keys(HELD) as Name[]).map((name, index) => file(name, index + 1));
const [report, guide, script, bundle] = files as [
  SessionArtifact,
  SessionArtifact,
  SessionArtifact,
  SessionArtifact,
];

function gateway() {
  const refused = async (): Promise<never> => {
    throw new Error('Not asked of a file.');
  };

  return {
    sessionArtifacts: vi.fn(async () => [...files]),
    sessionArtifactVersion: vi.fn(
      async (_profile: string, _session: string, artifactId: string, version: number) => ({
        artifactId,
        version,
        author: 'agent' as const,
        // A file's version holds no source: it names the file.
        content: '',
        file: files.find((item) => item.id === artifactId)?.file,
        createdAt: at,
      }),
    ),
    media: vi.fn(async (profileId: string, mediaId: string) => {
      const held = HELD[mediaId as Name];

      return {
        id: mediaId,
        profileId,
        mimeType: held.mimeType,
        name: held.name,
        bytes: atob(held.data).length,
        data: held.data,
        createdAt: at,
      };
    }),
    exportSessionArtifact: vi.fn(refused),
    editSessionArtifact: vi.fn(refused),
    setSessionArtifactVisibility: vi.fn(refused),
  } satisfies ArtifactsApi;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useCrew.getState().show('session', []);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useCrew.setState({ tabs: [], opened: false, following: undefined });
  useCrew.getState().leave('session');
  vi.restoreAllMocks();
});

async function settled(done: () => boolean, limit = 100) {
  for (let tries = 0; tries < limit && !done(); tries += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

async function shown(artifact?: SessionArtifact) {
  const api = gateway();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  client.setQueryData(keys.gateway, { status: 'ok', mode: 'server' });
  await act(async () => useCrew.getState().showArtifacts(artifact?.id));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ArtifactsDrawer api={api} profileId="profile" />
      </QueryClientProvider>,
    ),
  );
  await settled(() =>
    artifact ? api.media.mock.results.length > 0 : Boolean(drawer()?.querySelector('li')),
  );
  // Once more, for what was read to be drawn.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  return api;
}

const drawer = () => container.querySelector('aside');
const button = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === label,
  );

describe('a file in the Artifacts tab', () => {
  beforeEach(() => {
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:synthetic'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('reads a PDF in the browser’s reader, from the conversation’s media', async () => {
    const api = await shown(report);

    expect(api.media).toHaveBeenCalledWith('profile', 'report');
    const frame = drawer()?.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('blob:synthetic');
    // Not the frame an Artifact runs in: nothing of the gateway's is loaded for a file.
    expect(frame?.getAttribute('src')).not.toContain('/v1/artifact-frames');
    // A file is not source: nothing to switch to, copy or edit.
    expect(button('View code')).toBeUndefined();
    expect(button('Edit')).toBeUndefined();
    expect(button('Download')).toBeDefined();
  });

  it('lays a Markdown file out, runs nothing of it, and shows its source on request', async () => {
    await shown(guide);
    await settled(() => Boolean(drawer()?.querySelector('article')));

    // Laid out as the panel lays Markdown out, where what was a tag is read as text.
    expect(drawer()?.querySelector('article')?.firstElementChild?.textContent).toBe('Guide');
    expect(drawer()?.querySelector('article')?.textContent).toContain('window.reached');
    expect(drawer()?.querySelector('iframe')).toBeNull();
    expect(drawer()?.querySelector('script')).toBeNull();
    expect((window as { reached?: boolean }).reached).toBeUndefined();

    await act(async () => button('View code')?.click());
    expect(drawer()?.querySelector('article')).toBeNull();
    expect(drawer()?.querySelector('pre')?.textContent).toContain('# Guide');
  });

  it('reads code as text, never as markup', async () => {
    await shown(script);

    expect(drawer()?.querySelector('pre')?.textContent).toBe('print("<b>hi</b>")');
    expect(drawer()?.querySelector('pre b')).toBeNull();
    expect(button('View code')).toBeUndefined();
  });

  it('offers a file with no reader as a card, and downloads it as it was given', async () => {
    await shown(bundle);

    expect(drawer()?.querySelector('.viewer-file')?.textContent).toContain('bundle.zip');
    expect(drawer()?.textContent).toContain('No preview for this format.');

    const saved: { name: string; blob: Blob }[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
      saved.push({ name: '', blob: blob as Blob });
      return 'blob:saved';
    });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      const last = saved.at(-1);
      if (last) last.name = this.download;
    });

    await act(async () => button('Download')?.click());

    expect(clicked).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)?.name).toBe('bundle.zip');
    expect(saved.at(-1)?.blob.type).toBe('application/zip');
    expect(saved.at(-1)?.blob.size).toBe(atob(HELD.bundle.data).length);
  });
});

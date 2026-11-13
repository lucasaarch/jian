import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionFile, SessionFileRoot } from '../../../lib/api';
import { GatewayAnswer } from '../../../lib/api/result';
import { useCrew } from '../../../lib/stores/crew';
import { FileView } from './file-view';
import { FilesDrawer } from './files-drawer';
import { useFiles } from './store';
import type { FilesApi } from './use-files';

const storefront: SessionFileRoot = {
  id: 'project-1',
  name: 'storefront',
  files: ['README.md', 'src/pricing.ts', 'src/cart.ts', 'logo.png'],
  changes: [
    { path: 'src/pricing.ts', status: 'modified' },
    { path: 'src/old.ts', status: 'deleted' },
  ],
  truncated: false,
};
const texts: Record<string, string> = {
  'README.md': '# Storefront\n\nPrices are in **cents**.\n',
  'src/pricing.ts': 'export const price = 1;\nexport const Price = price * 2;\n',
  'src/cart.ts': 'export const cart = [];\n',
};

function gateway(roots: SessionFileRoot[] = [storefront]) {
  return {
    sessionFiles: vi.fn(async () => ({ roots })),
    sessionFile: vi.fn(
      async (
        _profile: string,
        _session: string,
        root: string,
        path: string,
      ): Promise<SessionFile> =>
        path === 'logo.png'
          ? { root, path, size: 2048, unavailable: 'This is a binary file.' }
          : { root, path, size: texts[path]?.length ?? 0, text: texts[path] ?? '' },
    ),
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  useFiles.setState({ open: {}, toggled: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useCrew.getState().close();
});

async function render(api: FilesApi) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FileView api={api} profileId="profile" sessionId="session" />
        <FilesDrawer api={api} profileId="profile" />
      </QueryClientProvider>,
    ),
  );
}

async function settled(done: () => boolean, limit = 100) {
  for (let tries = 0; tries < limit && !done(); tries += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

const drawer = () => container.querySelector('aside') as HTMLElement;
const viewer = () => container.querySelector('.file-view');
/** A row of the tree or the filtered list, by the name it shows. */
const row = (name: string) =>
  [...drawer().querySelectorAll('li button')].find(
    (button) => button.querySelector('span.truncate')?.textContent === name,
  ) as HTMLButtonElement | undefined;
const rows = () =>
  [...drawer().querySelectorAll('li button')].map(
    (button) => button.querySelector('span.truncate')?.textContent,
  );
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | undefined)?.click());
const key = (init: KeyboardEventInit, target: EventTarget = document.body) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });

async function type(input: HTMLInputElement, words: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, words);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function shown(
  api: FilesApi,
  show = () => useCrew.getState().show('session', [], 'project-1'),
) {
  show();
  useCrew.getState().showFiles();
  await render(api);
  await settled(() => Boolean(drawer()?.querySelector('li button')));
}

async function opened(path: string, api: FilesApi = gateway()) {
  await shown(api);
  await act(async () => useFiles.getState().view('session', { root: 'project-1', path }));
  await settled(() => Boolean(viewer()) && !viewer()?.querySelector('[role=status]'));
}

describe('the Files tab', () => {
  it('lists the project’s files with its folders folded and its changes counted', async () => {
    await shown(gateway());

    expect(rows()).toEqual(['src', 'logo.png', 'README.md']);
    expect(drawer().textContent).toContain('5 files · 2 changed');
    expect(row('src')?.getAttribute('aria-expanded')).toBe('false');
    expect(row('src')?.textContent).toContain('2changed files');
  });

  it('opens a folder, marks what changed in it, and finds it open the next time', async () => {
    await shown(gateway());
    await click(row('src'));

    expect(rows()).toEqual(['src', 'cart.ts', 'old.ts', 'pricing.ts', 'logo.png', 'README.md']);
    expect(row('pricing.ts')?.querySelector('[role=img]')?.getAttribute('aria-label')).toBe(
      'Modified',
    );
    expect(row('old.ts')?.querySelector('[role=img]')?.getAttribute('aria-label')).toBe('Deleted');
    expect(row('cart.ts')?.querySelector('[role=img]')).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(gateway());
    await settled(() => Boolean(drawer()?.querySelector('li button')));
    expect(rows()).toContain('pricing.ts');
  });

  it('opens a file in the conversation’s place and leaves the Inspector open', async () => {
    const api = gateway();
    await shown(api);
    await click(row('src'));
    await click(row('cart.ts'));
    await settled(() => Boolean(viewer()?.querySelector('.file-code-line')));

    expect(api.sessionFile).toHaveBeenCalledWith('profile', 'session', 'project-1', 'src/cart.ts');
    expect(viewer()?.querySelector('.file-code-line')?.textContent).toBe(
      'export const cart = [];\n',
    );
    expect(row('cart.ts')?.getAttribute('aria-current')).toBe('true');
    expect(useCrew.getState().opened).toBe(true);
    expect(useCrew.getState().following).toBe('files:session');
  });

  it('opens a deleted file’s diff in Changes, since there is nothing to read', async () => {
    const api = gateway();
    await shown(api);
    await click(row('src'));
    await click(row('old.ts'));

    expect(useFiles.getState().open.session).toBeUndefined();
    expect(api.sessionFile).not.toHaveBeenCalled();
    expect(useCrew.getState().following).toBe('changes:session');
    expect(useCrew.getState().tabs.find((tab) => tab.kind === 'changes')).toMatchObject({
      path: 'src/old.ts',
    });
  });

  it('heads each project of several with its name and reads a file from its own', async () => {
    const api = gateway([
      storefront,
      {
        id: 'project-2',
        name: 'billing',
        files: ['src/cart.ts'],
        changes: [{ path: 'gone.ts', status: 'deleted' }],
        truncated: false,
      },
      {
        id: 'project-3',
        name: 'docs',
        files: [],
        changes: [],
        truncated: false,
        unavailable: 'Not checked out yet: the agent clones it when it first works on it.',
      },
    ]);
    await shown(api, () => useCrew.getState().show('session', [], undefined, undefined, true));

    expect(rows().filter((name) => ['storefront', 'billing', 'docs'].includes(name ?? ''))).toEqual(
      ['storefront', 'billing', 'docs'],
    );
    expect(drawer().textContent).toContain('Not checked out yet');
    // Changes reads one checkout: a file deleted in one project of several has no diff to open.
    expect(row('gone.ts')?.disabled).toBe(true);

    const folders = [...drawer().querySelectorAll('li button')].filter(
      (button) => button.querySelector('span.truncate')?.textContent === 'src',
    );
    await click(folders[1]);
    const carts = [...drawer().querySelectorAll('li button')].filter(
      (button) => button.querySelector('span.truncate')?.textContent === 'cart.ts',
    );
    expect(carts).toHaveLength(1);
    await click(carts[0]);

    expect(api.sessionFile).toHaveBeenCalledWith('profile', 'session', 'project-2', 'src/cart.ts');
  });

  it('filters by any part of the path, with no filter of its own for changes', async () => {
    await shown(gateway());
    const filter = drawer().querySelector('input') as HTMLInputElement;

    await type(filter, 'SRC/');
    expect(rows()).toEqual(['cart.ts', 'old.ts', 'pricing.ts']);
    expect(drawer().textContent).toContain('3 files of 5');

    // Changes lists only what changed; the tree's bar has the filter alone.
    expect(drawer().querySelector('[aria-pressed]')).toBeNull();

    await type(filter, 'nothing-like-this');
    expect(rows()).toEqual([]);
    expect(drawer().textContent).toContain('No file matches “nothing-like-this”.');
  });

  it('says a list is cut short', async () => {
    await shown(gateway([{ ...storefront, truncated: true }]));

    expect(drawer().textContent).toContain('list cut short');
    expect(drawer().textContent).toContain('the checkout has more files than are shown');
  });

  it('shows the gateway’s sentence when it refuses, with nothing to press', async () => {
    const api = {
      ...gateway(),
      sessionFiles: vi.fn(async () => {
        throw new GatewayAnswer('Files of a conversation on a machine can’t be shown yet.', 409);
      }),
    };
    useCrew.getState().show('session', [], 'project-1');
    useCrew.getState().showFiles();
    await render(api);
    await settled(() => Boolean(drawer()?.querySelector('[role=alert]')));

    expect(drawer().querySelector('[role=alert]')?.textContent).toBe(
      'Files of a conversation on a machine can’t be shown yet.',
    );
    expect(drawer().textContent).not.toContain('Try again');
  });
});

describe('the file in the conversation’s place', () => {
  const button = (label: string) =>
    viewer()?.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  /** The entries of the bar's one menu, opened from its button; the menu draws them in a portal. */
  const entries = async () => {
    await click(button('File options'));
    await settled(() => document.querySelectorAll('[role=menuitem]').length > 0);
    return [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
  };
  const choose = async (label: string) =>
    click((await entries()).find((entry) => entry.textContent === label));
  const closeMenu = () => key({ key: 'Escape' }, document.activeElement ?? document.body);

  it('keeps the bar to the way back and one menu of everything else', async () => {
    await opened('src/pricing.ts');
    const labels = [...(viewer()?.querySelectorAll('header button') ?? [])].map((b) =>
      b.getAttribute('aria-label'),
    );

    expect(labels).toEqual(['Back to conversation', 'File options']);
    expect((await entries()).map((entry) => entry.textContent)).toEqual([
      'Wrap lines',
      'Find in file',
      'Open diff',
      'Copy path',
      'Copy contents',
    ]);
  });

  it('shows code with its lines numbered, its change and the way to its diff', async () => {
    await opened('src/pricing.ts');
    const lines = [...(viewer()?.querySelectorAll('.file-code-line') ?? [])];

    expect(lines.map((line) => line.getAttribute('data-line'))).toEqual(['1', '2']);
    expect(lines[1]?.textContent).toBe('export const Price = price * 2;\n');
    expect(viewer()?.querySelector('h1')?.textContent).toBe('storefront/src/pricing.ts');
    expect(viewer()?.textContent).toContain('Modified');
    // Nothing of it can be typed into: it is read only.
    expect(viewer()?.querySelector('textarea, [contenteditable]')).toBeNull();

    await choose('Open diff');
    expect(useCrew.getState().following).toBe('changes:session');
    expect(useCrew.getState().tabs.find((tab) => tab.kind === 'changes')).toMatchObject({
      path: 'src/pricing.ts',
    });
    expect(viewer()).not.toBeNull();
  });

  it('reads Markdown as a page first, with its code one press away', async () => {
    await opened('README.md');

    expect(viewer()?.querySelector('article h3')?.textContent).toBe('Storefront');
    expect(viewer()?.querySelector('article strong')?.textContent).toBe('cents');
    expect(viewer()?.querySelector('.file-code')).toBeNull();

    await choose('Show code');
    expect(viewer()?.querySelector('.file-code-line')?.textContent).toBe('# Storefront\n');

    await choose('Show preview');
    expect(viewer()?.querySelector('article h3')?.textContent).toBe('Storefront');
  });

  it('finds words with Ctrl+F, and Escape closes the bar before it leaves the file', async () => {
    await opened('src/pricing.ts');
    await key({ key: 'f', ctrlKey: true });
    const find = viewer()?.querySelector('search input, [role=search] input') as HTMLInputElement;

    expect(document.activeElement).toBe(find);
    await type(find, 'price');
    expect(viewer()?.querySelector('[role=status]')?.textContent).toBe('1 of 3');
    await key({ key: 'Enter' }, find);
    expect(viewer()?.querySelector('mark[data-current]')?.closest('[data-line]')).toBe(
      viewer()?.querySelectorAll('.file-code-line')[1],
    );

    await key({ key: 'Escape' }, find);
    expect(viewer()?.querySelector('mark')).toBeNull();
    expect(useFiles.getState().open.session).toBeDefined();

    await key({ key: 'Escape' });
    expect(viewer()).toBeNull();
    expect(useCrew.getState().opened).toBe(true);
  });

  it('searches a Markdown page in its code', async () => {
    await opened('README.md');
    await key({ key: 'f', metaKey: true });

    expect(viewer()?.querySelector('article')).toBeNull();
    expect(viewer()?.querySelector('.file-code')).not.toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Find');
  });

  it('keeps the file open when Escape is for a field outside it', async () => {
    await opened('src/cart.ts');
    const filter = drawer().querySelector('input') as HTMLInputElement;
    await type(filter, 'cart');
    await key({ key: 'Escape' }, filter);

    expect(filter.value).toBe('');
    expect(viewer()).not.toBeNull();
  });

  it('goes back to the conversation with its one button', async () => {
    await opened('src/cart.ts');
    await click(button('Back to conversation'));

    expect(viewer()).toBeNull();
    expect(useFiles.getState().open.session).toBeUndefined();
    expect(useCrew.getState().opened).toBe(true);
  });

  it('says why a file cannot be shown instead of its bytes', async () => {
    await opened('logo.png');

    expect(viewer()?.textContent).toContain('This is a binary file. It is 2.0 KB.');
    expect(viewer()?.querySelector('.file-code')).toBeNull();
    expect((await entries()).map((entry) => entry.textContent)).toEqual(['Copy path']);
    await closeMenu();
  });

  it('finds from the menu, with the keyboard in the find field', async () => {
    await opened('README.md');
    await choose('Find in file');
    await settled(() => document.activeElement?.getAttribute('aria-label') === 'Find');

    expect(viewer()?.querySelector('.file-code')).not.toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Find');
  });

  it('shows the gateway’s sentence for a file that is gone, with nothing to press', async () => {
    const api = {
      ...gateway(),
      sessionFile: vi.fn(async () => {
        throw new GatewayAnswer('That file is not in this checkout.', 404);
      }),
    };
    await shown(api);
    await act(async () =>
      useFiles.getState().view('session', { root: 'project-1', path: 'src/cart.ts' }),
    );
    await settled(() => Boolean(viewer()?.querySelector('[role=alert]')));

    expect(viewer()?.querySelector('[role=alert]')?.textContent).toBe(
      'That file is not in this checkout.',
    );
    expect(viewer()?.textContent).not.toContain('Try again');
    expect(button('Back to conversation')).not.toBeNull();
  });
});

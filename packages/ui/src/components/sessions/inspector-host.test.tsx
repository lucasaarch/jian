import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCrew } from '../../lib/stores/crew';
import { MIN_CHAT_WIDTH } from '../../lib/stores/layout';
import { focusInspector, InspectorHost, toggleInspector } from './inspector-host';

const KEY = 'jian:inspector-size';
const page = (id: string, title = '', url = '') => ({
  key: `browser:${id}`,
  kind: 'browser' as const,
  pageId: id,
  title,
  url,
});
let root: Root | undefined;
let element: HTMLDivElement;
let room = 1600;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  room = 1600;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width: room }) as DOMRect,
  );
  useCrew.setState({
    sessionId: 'atlas',
    agents: [],
    tabs: [page('one', 'Atlas Docs')],
    opened: true,
    full: false,
    following: 'browser:one',
    last: undefined,
    item: undefined,
    openBrowser: undefined,
  });
  element = document.createElement('div');
  document.body.append(element);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  element.remove();
  vi.restoreAllMocks();
});

const show = async () => {
  root = createRoot(element);
  await act(async () => root?.render(<InspectorHost browser={<p>Page</p>}>Chat</InspectorHost>));
};
const shown = () =>
  element
    .querySelector<HTMLElement>('[data-inspector-host]')
    ?.style.getPropertyValue('--inspector-width');
const divider = () => element.querySelector('hr') as HTMLElement;

it('opens at a size a page can be read in, without treating that as the owner choosing it', async () => {
  await show();

  expect(shown()).toBe('800px');
  expect(localStorage.getItem(KEY)).toBeNull();
});

it('keeps the size the owner chose across a reload', async () => {
  await show();
  await act(async () => {
    divider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  });
  expect(shown()).toBe('832px');
  expect(localStorage.getItem(KEY)).toBe('832');

  await act(async () => root?.unmount());
  await show();

  expect(shown()).toBe('832px');
});

it('fits a narrow window without forgetting the size the owner chose', async () => {
  localStorage.setItem(KEY, '900');
  room = 1000;

  await show();

  // The chat keeps its minimum, and the owner's size stays for when there is room again.
  expect(shown()).toBe('600px');
  expect(localStorage.getItem(KEY)).toBe('900');
});

const host = () => element.querySelector<HTMLElement>('[data-inspector-host]');

it('leaves the chat its minimum beside a sidebar, however wide the owner dragged it', async () => {
  localStorage.setItem(KEY, '1500');
  room = 1280;
  const sidebar = 256;
  vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(function (this: Element) {
    return { width: this.hasAttribute('data-chat-sidebar') ? sidebar : room } as DOMRect;
  });
  root = createRoot(element);
  await act(async () =>
    root?.render(
      <InspectorHost browser={<p>Page</p>} wholePanel>
        <nav data-chat-sidebar />
      </InspectorHost>,
    ),
  );

  expect(shown()).toBe(`${1280 - 256 - MIN_CHAT_WIDTH}px`);
  expect(host()?.hasAttribute('data-full')).toBe(false);

  // Full screen takes the chat's area and leaves the sidebar exactly as wide as it was.
  await act(async () =>
    element.querySelector<HTMLButtonElement>('[aria-label="Full screen"]')?.click(),
  );
  expect(host()?.hasAttribute('data-full')).toBe(true);
  expect(element.querySelector<HTMLElement>('[data-inspector-beside]')?.style.width).toBe('256px');
});

it('takes the chat’s place when both cannot fit, rather than crush it', async () => {
  room = 660;
  await show();

  expect(host()?.hasAttribute('data-full')).toBe(true);
  // There is no chat to go back to until the window has room for one.
  expect(
    element.querySelector<HTMLButtonElement>('[aria-label="Exit full screen"]')?.disabled,
  ).toBe(true);

  room = 1600;
  await act(async () => {
    root?.unmount();
  });
  await show();
  expect(host()?.hasAttribute('data-full')).toBe(false);
});

it('goes full screen and back, holding the conversation in place', async () => {
  await show();

  await act(async () =>
    element.querySelector<HTMLButtonElement>('[aria-label="Full screen"]')?.click(),
  );
  expect(host()?.hasAttribute('data-full')).toBe(true);
  expect(element.textContent).toContain('Chat');

  await act(async () =>
    element.querySelector<HTMLButtonElement>('[aria-label="Exit full screen"]')?.click(),
  );
  expect(host()?.hasAttribute('data-full')).toBe(false);
});

it('focuses what an agent asked for only in the conversation it works in', () => {
  focusInspector('atlas', {
    sessionId: 'other-conversation',
    kind: 'pull_request',
    url: 'https://github.com/atlas-example/site/pull/7',
  });
  expect(useCrew.getState().following).toBe('browser:one');

  focusInspector('atlas', {
    sessionId: 'atlas',
    kind: 'pull_request',
    url: 'https://github.com/atlas-example/site/pull/7',
  });
  expect(useCrew.getState().following).toBe('github:atlas-example/site#7');

  focusInspector('atlas', { sessionId: 'atlas', kind: 'subagent', runId: 'reviewer' });
  expect(useCrew.getState().following).toBe('reviewer');
});

it('ignores a link that is not a pull request or an issue', () => {
  focusInspector('atlas', {
    sessionId: 'atlas',
    kind: 'issue',
    url: 'https://example.test/atlas/site/issues/7',
  });

  expect(useCrew.getState().following).toBe('browser:one');
});

it('brings the browser forward if it has one, opens one if not, and does nothing without a host', () => {
  const openBrowser = vi.fn();
  useCrew.setState({ tabs: [], following: undefined, opened: false });

  focusInspector('atlas', { sessionId: 'atlas', kind: 'browser' });
  expect(useCrew.getState().opened).toBe(false);

  useCrew.setState({ openBrowser });
  focusInspector('atlas', { sessionId: 'atlas', kind: 'browser' });
  expect(openBrowser).toHaveBeenCalledOnce();

  useCrew.setState({ tabs: [page('two', 'Atlas')] });
  focusInspector('atlas', { sessionId: 'atlas', kind: 'browser' });
  expect(openBrowser).toHaveBeenCalledOnce();
  expect(useCrew.getState().following).toBe('browser:two');
});

const crew = () => useCrew.getState();
const pull = {
  kind: 'pull' as const,
  owner: 'atlas-example',
  repo: 'site',
  number: 7,
  url: 'https://github.com/atlas-example/site/pull/7',
};
const clean = () =>
  useCrew.setState({
    sessionId: undefined,
    tabs: [],
    opened: false,
    following: undefined,
    last: undefined,
    item: undefined,
  });

it('gives each conversation its own tabs, and brings them back on return', () => {
  clean();
  crew().show('one', []);
  crew().open(pull);
  crew().browser('a');
  crew().select('github:atlas-example/site#7');

  crew().leave('one');
  crew().show('two', []);
  expect(crew().tabs).toEqual([]);
  expect(crew().opened).toBe(false);
  crew().browser('b');

  crew().leave('two');
  crew().show('one', []);
  expect(crew().tabs.map((tab) => tab.key)).toEqual(['github:atlas-example/site#7', 'browser:a']);
  expect(crew().following).toBe('github:atlas-example/site#7');
  expect(crew().item?.number).toBe(7);

  crew().leave('one');
  crew().show('two', []);
  expect(crew().tabs.map((tab) => tab.key)).toEqual(['browser:b']);
  expect(crew().following).toBe('browser:b');
});

it('holds no tab for a conversation closed with none open', () => {
  clean();
  crew().show('three', []);
  crew().browser('a');
  crew().remove('browser:a');
  crew().leave('three');
  crew().show('three', []);

  expect(crew().tabs).toEqual([]);
  expect(crew().following).toBeUndefined();
});

it('closes without losing its tabs, and opens again where it was', () => {
  clean();
  crew().open(pull);
  crew().browser('a');
  crew().select('github:atlas-example/site#7');

  crew().close();
  expect(crew().opened).toBe(false);
  expect(crew().following).toBeUndefined();
  expect(crew().tabs).toHaveLength(2);

  crew().reopen();
  expect(crew().opened).toBe(true);
  expect(crew().following).toBe('github:atlas-example/site#7');
  expect(crew().item?.number).toBe(7);
});

it('opens and closes from its key, and stays closed where it has nothing to show', () => {
  clean();
  useCrew.setState({ openBrowser: undefined });
  toggleInspector();
  expect(crew().opened).toBe(false);

  useCrew.setState({ openBrowser: () => {} });
  toggleInspector();
  expect(crew().opened).toBe(true);
  toggleInspector();
  expect(crew().opened).toBe(false);
});

it('follows the host: names, new tabs and those gone, keeping the others in place', () => {
  clean();
  crew().open(pull);
  crew().browser('a');
  crew().browser('b');

  crew().syncBrowser([
    { id: 'a', title: 'Atlas Docs', url: 'https://atlas.test/docs' },
    { id: 'b', title: 'Nova', url: 'https://nova.test/' },
    { id: 'c', title: '', url: '' },
  ]);
  expect(crew().tabs.map((tab) => tab.key)).toEqual([
    'github:atlas-example/site#7',
    'browser:a',
    'browser:b',
    'browser:c',
  ]);
  expect(crew().tabs[1]).toMatchObject({ title: 'Atlas Docs', url: 'https://atlas.test/docs' });

  const untouched = crew().tabs;
  crew().syncBrowser([
    { id: 'a', title: 'Atlas Docs', url: 'https://atlas.test/docs' },
    { id: 'b', title: 'Nova', url: 'https://nova.test/' },
    { id: 'c', title: '', url: '' },
  ]);
  expect(crew().tabs).toBe(untouched);

  crew().syncBrowser([{ id: 'a', title: 'Atlas Docs', url: 'https://atlas.test/docs' }]);
  expect(crew().tabs.map((tab) => tab.key)).toEqual(['github:atlas-example/site#7', 'browser:a']);
  expect(crew().following).toBe('browser:a');
});

const inTabs = () => [...element.querySelectorAll('[role=tab]')].map((tab) => tab.textContent);
const shownWith = async (openBrowser?: () => void) => {
  root = createRoot(element);
  await act(async () =>
    root?.render(
      <InspectorHost browser={<p>Page</p>} {...(openBrowser ? { openBrowser } : {})}>
        Chat
      </InspectorHost>,
    ),
  );
};

it('names a browser tab after its page, and offers the way to open another', async () => {
  useCrew.setState({ tabs: [page('one', 'Atlas Docs'), page('two', '', 'https://nova.test/')] });
  await shownWith(() => {});

  expect(inTabs()).toEqual(['Atlas Docs', 'https://nova.test/']);
  expect(element.querySelector('[aria-label="Open in inspector"]')).not.toBeNull();
});

it('opens empty with what it can open, and the last tab closed comes back to that', async () => {
  const openBrowser = vi.fn();
  useCrew.setState({ tabs: [], following: undefined, opened: true });
  await shownWith(openBrowser);

  const offer = [...element.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith('Browser'),
  );
  // The way to more tabs waits for a first one: the page itself is that way.
  expect(element.querySelector('[aria-label="Open in inspector"]')).toBeNull();
  await act(async () => offer?.click());
  expect(openBrowser).toHaveBeenCalledOnce();

  await act(async () =>
    useCrew.setState({ tabs: [page('one', 'Atlas')], following: 'browser:one' }),
  );
  await act(async () =>
    element.querySelector<HTMLButtonElement>('[aria-label="Close Atlas tab"]')?.click(),
  );
  expect(crew().opened).toBe(true);
  expect(element.textContent).toContain('Keep something open');
});

it('closes rather than empties where nothing can be opened in it', async () => {
  useCrew.setState({ tabs: [page('one', 'Atlas')], following: 'browser:one' });
  await shownWith();

  await act(async () =>
    element.querySelector<HTMLButtonElement>('[aria-label="Close Atlas tab"]')?.click(),
  );

  expect(crew().opened).toBe(false);
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCrew } from '../../lib/stores/crew';
import { focusInspector, InspectorHost } from './inspector-host';

const KEY = 'jian:inspector-size';
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
    tabs: [{ key: 'browser', kind: 'browser' }],
    following: 'browser',
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

  expect(shown()).toBe('680px');
  expect(localStorage.getItem(KEY)).toBe('900');
});

it('focuses what an agent asked for only in the conversation it works in', () => {
  focusInspector('atlas', {
    sessionId: 'other-conversation',
    kind: 'pull_request',
    url: 'https://github.com/atlas-example/site/pull/7',
  });
  expect(useCrew.getState().following).toBe('browser');

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

  expect(useCrew.getState().following).toBe('browser');
});

it('asks the host for its browser, and does nothing on a host without one', () => {
  const openBrowser = vi.fn();
  useCrew.setState({ following: undefined });

  focusInspector('atlas', { sessionId: 'atlas', kind: 'browser' });
  expect(useCrew.getState().following).toBeUndefined();

  useCrew.setState({ openBrowser });
  focusInspector('atlas', { sessionId: 'atlas', kind: 'browser' });
  expect(openBrowser).toHaveBeenCalledOnce();
});

it('gives each conversation its own tabs, and brings them back on return', () => {
  const crew = () => useCrew.getState();
  useCrew.setState({ sessionId: undefined, tabs: [], following: undefined, item: undefined });

  crew().show('one', []);
  crew().open({
    kind: 'pull',
    owner: 'atlas-example',
    repo: 'site',
    number: 7,
    url: 'https://github.com/atlas-example/site/pull/7',
  });
  crew().browser();
  crew().select('github:atlas-example/site#7');

  crew().leave('one');
  crew().show('two', []);
  expect(crew().tabs).toEqual([]);
  expect(crew().following).toBeUndefined();
  crew().browser();

  crew().leave('two');
  crew().show('one', []);
  expect(crew().tabs.map((tab) => tab.key)).toEqual(['github:atlas-example/site#7', 'browser']);
  expect(crew().following).toBe('github:atlas-example/site#7');
  expect(crew().item?.number).toBe(7);

  crew().leave('one');
  crew().show('two', []);
  expect(crew().tabs.map((tab) => tab.key)).toEqual(['browser']);
  expect(crew().following).toBe('browser');
});

it('holds no tab for a conversation closed with none open', () => {
  const crew = () => useCrew.getState();
  useCrew.setState({ sessionId: undefined, tabs: [], following: undefined, item: undefined });

  crew().show('three', []);
  crew().browser();
  crew().remove('browser');
  crew().leave('three');
  crew().show('three', []);

  expect(crew().tabs).toEqual([]);
  expect(crew().following).toBeUndefined();
});

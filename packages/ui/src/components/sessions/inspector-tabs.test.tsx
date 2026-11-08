import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type InspectorTab, useCrew } from '../../lib/stores/crew';
import { InspectorHost } from './inspector-host';

/** The strip's width, and where each tab sits in it unscrolled, in px. */
const STRIP = 200;
const TAB = 140;
const STEP = 150;
const tabs: InspectorTab[] = [101, 102, 103, 104, 105].map((number) => ({
  key: `github:atlas/web#${number}`,
  kind: 'github',
  item: { kind: 'pull', owner: 'atlas', repo: 'web', number, url: '' },
}));
let root: Root | undefined;
let element: HTMLDivElement;

const strip = () => element.querySelector<HTMLElement>('[role="tablist"]') as HTMLElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  // A layout happy-dom does not compute: the tabs in a row, wider together than the strip, moved
  // by how far the strip is scrolled.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const list = this.parentElement?.getAttribute('role') === 'tablist' ? this.parentElement : null;
    if (this.getAttribute('role') === 'tablist') {
      return { left: 0, right: STRIP, width: STRIP } as DOMRect;
    }
    if (list) {
      const left = [...list.children].indexOf(this) * STEP - list.scrollLeft;
      return { left, right: left + TAB, width: TAB } as DOMRect;
    }
    return { left: 0, right: 1600, width: 1600 } as DOMRect;
  });
  for (const [name, value] of [
    ['scrollWidth', tabs.length * STEP],
    ['clientWidth', STRIP],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, name, 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tablist' ? value : 0;
    });
  }
  useCrew.setState({
    sessionId: 'atlas',
    agents: [],
    tabs,
    opened: true,
    full: false,
    following: tabs[0]?.key,
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
  await act(async () => root?.render(<InspectorHost>Chat</InspectorHost>));
};

it('brings the tab it turns to into view, and leaves the strip where it is for one in view', async () => {
  await show();
  expect(strip().scrollLeft).toBe(0);

  await act(async () => useCrew.getState().select(tabs[3]?.key ?? ''));
  // The fourth tab ends at 590px; the strip shows 200px of it, clear of the fade at its edge.
  const scrolled = strip().scrollLeft;
  expect(scrolled).toBeGreaterThanOrEqual(3 * STEP + TAB - STRIP);
  expect(scrolled).toBeLessThanOrEqual(3 * STEP);

  await act(async () => useCrew.getState().select(tabs[0]?.key ?? ''));
  expect(strip().scrollLeft).toBe(0);
});

it('turns the wheel into a sideways scroll while the tabs overflow', async () => {
  await show();
  const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });

  await act(async () => strip().dispatchEvent(wheel));

  expect(strip().scrollLeft).toBe(120);
  expect(wheel.defaultPrevented).toBe(true);
});

it('marks the edges that have more tabs past them', async () => {
  await show();
  expect(strip().hasAttribute('data-more-end')).toBe(true);
  expect(strip().hasAttribute('data-more-start')).toBe(false);

  await act(async () => {
    strip().scrollLeft = tabs.length * STEP - STRIP;
    strip().dispatchEvent(new Event('scroll'));
  });
  expect(strip().hasAttribute('data-more-start')).toBe(true);
  expect(strip().hasAttribute('data-more-end')).toBe(false);
});

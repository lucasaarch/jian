import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type InspectorTab, useCrew } from '../../lib/stores/crew';
import { InspectorHost } from './inspector-host';

/** The strip's width, and where each tab sits in it unscrolled, in px. */
const STRIP = 400;
const TAB = 140;
const STEP = 150;
const tabs: InspectorTab[] = [101, 102, 103, 104, 105].map((number) => ({
  key: `github:atlas/web#${number}`,
  kind: 'github',
  item: { kind: 'pull', owner: 'atlas', repo: 'web', number, url: '' },
}));
/** How wide the tabs are together; the strip overflows while this passes `STRIP`. */
let wide = tabs.length * STEP;
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
  wide = tabs.length * STEP;
  for (const [name, value] of [
    ['scrollWidth', () => wide],
    ['clientWidth', () => STRIP],
  ] as const) {
    vi.spyOn(HTMLElement.prototype, name, 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tablist' ? value() : 0;
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
  // The fourth tab runs from 450px to 590px: the strip shows it whole, clear of the fade.
  const scrolled = strip().scrollLeft;
  expect(scrolled).toBeGreaterThanOrEqual(3 * STEP + TAB - STRIP);
  expect(scrolled).toBeLessThanOrEqual(3 * STEP);

  // The third, 300px to 440px, is already in view beside it.
  await act(async () => useCrew.getState().select(tabs[2]?.key ?? ''));
  expect(strip().scrollLeft).toBe(scrolled);

  await act(async () => useCrew.getState().select(tabs[0]?.key ?? ''));
  expect(strip().scrollLeft).toBe(0);
});

const wheel = (init: WheelEventInit) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  // happy-dom's WheelEvent leaves out the modifier keys it is given.
  if (init.ctrlKey) Object.defineProperty(event, 'ctrlKey', { value: true });
  strip().dispatchEvent(event);
  return event;
};

it('turns the wheel into a sideways scroll while the tabs overflow', async () => {
  await show();
  let event: WheelEvent | undefined;
  await act(async () => {
    event = wheel({ deltaY: 120 });
  });

  expect(strip().scrollLeft).toBe(120);
  expect(event?.defaultPrevented).toBe(true);
});

it('leaves the wheel to the page when the tabs fit, at their end, or for a sideways swipe', async () => {
  wide = STRIP;
  await show();
  expect(wheel({ deltaY: 120 }).defaultPrevented).toBe(false);
  expect(strip().scrollLeft).toBe(0);

  wide = tabs.length * STEP;
  // A trackpad's own sideways scroll is the browser's.
  expect(wheel({ deltaX: 80, deltaY: 10 }).defaultPrevented).toBe(false);
  // Zooming, not scrolling.
  expect(wheel({ deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(false);
  // Already at the start, turned back towards it.
  expect(wheel({ deltaY: -120 }).defaultPrevented).toBe(false);

  strip().scrollLeft = wide - STRIP;
  expect(wheel({ deltaY: 120 }).defaultPrevented).toBe(false);
  expect(strip().scrollLeft).toBe(wide - STRIP);
});

it('marks the edges that have more tabs past them', async () => {
  await show();
  expect(strip().hasAttribute('data-more-end')).toBe(true);
  expect(strip().hasAttribute('data-more-start')).toBe(false);

  await act(async () => {
    strip().scrollLeft = wide - STRIP;
    strip().dispatchEvent(new Event('scroll'));
  });
  expect(strip().hasAttribute('data-more-start')).toBe(true);
  expect(strip().hasAttribute('data-more-end')).toBe(false);
});

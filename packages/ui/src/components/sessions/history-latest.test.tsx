import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../lib/events', () => ({ subscribe: () => () => {} }));

import { History } from './history';

/** Every observer the page made: the test DOM lays nothing out, so a test says when sizes change. */
let observers: ResizeObserverCallback[] = [];
class Observer {
  constructor(private callback: ResizeObserverCallback) {
    observers.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    observers = observers.filter((callback) => callback !== this.callback);
  }
}

/** The view's geometry in px, as a browser would report it, with a reader who can scroll it. */
type Glide = { behavior?: ScrollBehavior; finish: () => void };
const geometry = (view: HTMLElement, client: number, height: number) => {
  let top = height - client;
  let total = height;
  const glides: Glide[] = [];
  const scrolled = () => view.dispatchEvent(new Event('scroll'));
  Object.defineProperty(view, 'clientHeight', { configurable: true, get: () => client });
  Object.defineProperty(view, 'scrollHeight', { configurable: true, get: () => total });
  Object.defineProperty(view, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, total - client));
    },
  });
  // A smooth scroll reports where it passes before it lands; it lands when the test says so.
  view.scrollTo = ((options: ScrollToOptions) => {
    const target = Math.min(options.top ?? top, total - client);
    const finish = () => {
      top = target;
      scrolled();
    };
    glides.push({ behavior: options.behavior, finish });
    if (options.behavior !== 'smooth') return finish();
    top = Math.round((top + target) / 2);
    scrolled();
  }) as HTMLElement['scrollTo'];

  return {
    glides,
    get top() {
      return top;
    },
    scroll: (to: number) =>
      act(async () => {
        view.scrollTop = to;
        scrolled();
      }),
    /** Content grows by `below` px under the reader and `above` px over them, kept in place. */
    grow: (below: number, above = 0) =>
      act(async () => {
        total += below + above;
        top += above;
        for (const callback of observers) callback([], {} as ResizeObserver);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }),
  };
};

const said = {
  id: 'hello',
  profileId: 'profile',
  sessionId: 'session',
  runId: 'hello-run',
  role: 'assistant' as const,
  content: 'The report is ready.',
  createdAt: '2026-11-07T10:00:00Z',
};
const api = { messages: async () => [said], activities: async () => [], timeline: async () => [] };

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', Observer);
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  observers = [];
  vi.unstubAllGlobals();
});

const mount = async () => {
  await act(async () => root.render(<History api={api} profileId="profile" sessionId="session" />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const view = element.querySelector<HTMLElement>('.message-history');
  if (!view) throw new Error('No history on screen');
  return geometry(view, 500, 2000);
};
const button = () => {
  const found = element.querySelector<HTMLButtonElement>('[aria-label="Go to the latest message"]');
  if (!found) throw new Error('No way back to the end');
  return found;
};
const shown = () => !button().hasAttribute('inert');
const dotted = () => Boolean(button().querySelector('.to-latest-dot'));

it('stays out of the way at the end and within a screen of it', async () => {
  const view = await mount();
  await view.scroll(1500);

  expect(shown()).toBe(false);
  expect(button().getAttribute('aria-hidden')).toBe('true');

  await view.scroll(1100);

  expect(shown()).toBe(false);
});

it('shows a screen or more from the end, and goes on coming back', async () => {
  const view = await mount();
  await view.scroll(900);

  expect(shown()).toBe(true);
  expect(button().getAttribute('aria-hidden')).toBeNull();

  await view.scroll(1200);

  expect(shown()).toBe(false);
});

it('glides to the end and follows what arrives, even while it glides', async () => {
  const view = await mount();
  await view.scroll(0);

  await act(async () => button().click());

  expect(view.glides.at(-1)?.behavior).toBe('smooth');
  // Halfway there, the agent writes on: the history follows it instead of stopping short.
  await view.grow(400);

  expect(view.top).toBe(1900);
  expect(shown()).toBe(false);

  await view.grow(300);

  expect(view.top).toBe(2200);
});

it('jumps to the end under reduced motion', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const view = await mount();
  await view.scroll(0);

  await act(async () => button().click());

  expect(view.glides.at(-1)?.behavior).toBe('auto');
  expect(view.top).toBe(1500);
  expect(shown()).toBe(false);
});

it('marks what arrives below while away, until the reader reaches the end', async () => {
  const view = await mount();
  await view.scroll(0);

  expect(dotted()).toBe(false);

  // Earlier pages read above the reader are not news.
  await view.grow(0, 800);

  expect(dotted()).toBe(false);

  await view.grow(120);

  expect(dotted()).toBe(true);

  // Coming closer is not reaching it.
  await view.scroll(view.top + 1000);

  expect(dotted()).toBe(true);

  await view.scroll(10_000);

  expect(dotted()).toBe(false);
  expect(shown()).toBe(false);
});

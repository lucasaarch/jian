import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '../../lib/api';

let hear: ((event: { type: string; data?: unknown }) => void) | undefined;
vi.mock('../../lib/events', () => ({
  subscribe: (listener: typeof hear) => {
    hear = listener;
    return () => {
      hear = undefined;
    };
  },
}));

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
const geometry = (view: HTMLElement, height: number) => {
  let client = 500;
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
      resize(() => {
        total += below + above;
        top += above;
      }),
    /** The view itself gets shorter or taller, as the composer grows or the window changes. */
    view: (height: number) =>
      resize(() => {
        client = height;
      }),
  };
};

/** Sizes change: every observer hears it, and what waits a frame for it is let through. */
const resize = (change: () => void) =>
  act(async () => {
    change();
    for (const callback of observers) callback([], {} as ResizeObserver);
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(40);
    else await new Promise((resolve) => setTimeout(resolve, 40));
  });

const said: Message = {
  id: 'hello',
  profileId: 'profile',
  sessionId: 'session',
  runId: 'hello-run',
  role: 'assistant',
  content: 'The report is ready.',
  createdAt: '2026-11-07T10:00:00Z',
};
let messages = [said];
const api = {
  messages: async () => messages,
  activities: async () => [],
  timeline: async () => [],
};

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
  messages = [said];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = async () => {
  await act(async () => root.render(<History api={api} profileId="profile" sessionId="session" />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const view = element.querySelector<HTMLElement>('.message-history');
  if (!view) throw new Error('No history on screen');
  const sized = geometry(view, 2000);
  // The rows replacing the skeleton resize the content, as a browser would report.
  await sized.grow(0);
  return sized;
};
const button = () => {
  const found = element.querySelector<HTMLButtonElement>('.to-latest button');
  if (!found) throw new Error('No way back to the end');
  return found;
};
const rows = () => element.querySelectorAll<HTMLElement>('.message-list > .history-row');
/** Another message reaches the conversation through the stream, as a new last row. */
const arrives = (content: string) =>
  act(async () => {
    messages = [
      ...messages,
      {
        ...said,
        id: `m-${content}`,
        runId: `run-${content}`,
        role: 'user',
        content,
        createdAt: '2026-11-07T10:05:00Z',
      },
    ];
    hear?.({ type: 'session.message', data: { sessionId: 'session' } });
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
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

it('names itself, and goes nowhere while it is hidden', async () => {
  const view = await mount();
  await view.scroll(0);

  expect(button().getAttribute('aria-label')).toBe('Go to the latest message');
});

it('marks a new last row while away, until the reader reaches the end', async () => {
  const view = await mount();
  await view.scroll(0);

  expect(dotted()).toBe(false);

  await arrives('One more thing.');
  expect(rows()).toHaveLength(2);
  await view.grow(120);

  expect(dotted()).toBe(true);
  expect(button().getAttribute('aria-label')).toBe('Go to the latest message, new messages below');

  // Coming closer is not reaching it.
  await view.scroll(view.top + 1000);

  expect(dotted()).toBe(true);

  await view.scroll(10_000);

  expect(dotted()).toBe(false);
  expect(button().getAttribute('aria-label')).toBe('Go to the latest message');
});

it('marks the last row growing while away, as an answer being written does', async () => {
  const view = await mount();
  const last = rows()[rows().length - 1] as HTMLElement;
  let height = 100;
  Object.defineProperty(last, 'offsetHeight', { configurable: true, get: () => height });
  await view.grow(0);
  await view.scroll(0);

  expect(dotted()).toBe(false);

  height = 220;
  await view.grow(120);

  expect(dotted()).toBe(true);
});

it('does not mark content that grows in place, or a view that changes size', async () => {
  const view = await mount();
  await view.scroll(0);

  // Earlier pages read above the reader.
  await view.grow(0, 800);
  // A tool opened around the reader, or an image loaded under them, short of the last row.
  await view.grow(300);
  // The composer grows with a long draft.
  await view.view(300);

  expect(dotted()).toBe(false);
});

it('stops gliding when the reader scrolls back up, and leaves them there', async () => {
  const view = await mount();
  await view.scroll(0);

  await act(async () => button().click());
  await view.scroll(300);
  await view.grow(400);

  expect(view.top).toBe(300);

  await view.grow(300);

  expect(view.top).toBe(300);
});

it('stops gliding when the reader takes the wheel or touches the history', async () => {
  for (const kind of ['wheel', 'touchstart', 'pointerdown']) {
    const view = await mount();
    await view.scroll(0);

    await act(async () => button().click());
    const halfway = view.top;
    await act(async () => {
      element.querySelector('.message-history')?.dispatchEvent(new Event(kind));
    });
    await view.grow(400);

    expect({ kind, top: view.top }).toEqual({ kind, top: halfway });
    await act(async () => root.unmount());
    root = createRoot(element);
    observers = [];
  }
});

it('follows after a glide that never landed only if it left the reader at the end', async () => {
  const view = await mount();
  await view.scroll(0);
  vi.useFakeTimers();

  await act(async () => button().click());
  const halfway = view.top;
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  await view.grow(400);

  expect(view.top).toBe(halfway);
});

it('hands focus to the history when the keyboard pressed it', async () => {
  const view = await mount();
  await view.scroll(0);
  button().focus();

  await act(async () => button().click());

  expect(document.activeElement).toBe(element.querySelector('.message-history'));
});

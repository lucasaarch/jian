import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GatewayAnswer } from '../../../lib/api/result';
import { useCrew } from '../../../lib/stores/crew';
import { InspectorHost } from '../inspector-host';
import { TerminalDrawer } from './drawer';
import type { TerminalApi } from './link';
import { openTerminalTab } from './tabs';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

type Handlers = Parameters<TerminalApi['terminalOutput']>[2];

const terminal = (id: string) => ({
  key: `terminal:${id}`,
  kind: 'terminal' as const,
  terminalId: id,
});
const page = {
  key: 'browser:one',
  kind: 'browser' as const,
  pageId: 'one',
  title: 'Atlas',
  url: '',
};

/**
 * A gateway with three terminals worth telling apart: `lost-*` it no longer has, `done-*` whose
 * shell exited with 2, and any other, running until its reader goes away.
 */
function gateway(opened: string[] = []) {
  const ids = [...opened];
  return {
    openTerminal: vi.fn(async () => {
      const id = ids.shift();
      if (!id) {
        throw new GatewayAnswer('This gateway already has 12 terminals open.', 429);
      }
      return { id };
    }),
    closeTerminal: vi.fn(async () => undefined),
    writeTerminal: vi.fn(async () => undefined),
    resizeTerminal: vi.fn(async () => undefined),
    terminalOutput: vi.fn(
      async (_profile: string, id: string, handlers: Handlers, signal: AbortSignal) => {
        if (id.startsWith('lost')) {
          throw new GatewayAnswer('The terminal is not available.', 404);
        }
        handlers.opened();
        if (id.startsWith('done')) return handlers.exit(2);
        await new Promise((_, reject) => signal.addEventListener('abort', reject));
      },
    ),
  };
}

let root: Root | undefined;
let element: HTMLDivElement;
let api: ReturnType<typeof gateway>;
const crew = () => useCrew.getState();
const settle = () => act(async () => vi.dynamicImportSettled());
const show = async (tabs: ReturnType<typeof crew>['tabs'], opened: string[] = []) => {
  api = gateway(opened);
  useCrew.setState({ tabs, following: tabs.at(-1)?.key });
  root = createRoot(element);
  await act(async () =>
    root?.render(
      <InspectorHost>
        <TerminalDrawer api={api as unknown as TerminalApi} profileId="mia" />
      </InspectorHost>,
    ),
  );
  await settle();
};
const inTabs = () => [...element.querySelectorAll('[role=tab]')].map((tab) => tab.textContent);
const said = () => element.querySelector('[role=status]')?.textContent ?? '';
const press = async (name: string) => {
  const button = [...element.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.startsWith(name),
  );
  expect(button, name).toBeDefined();
  await act(async () => button?.click());
  await settle();
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  toast.error.mockClear();
  useCrew.setState({
    sessionId: 'atlas',
    agents: [],
    tabs: [],
    opened: true,
    full: false,
    following: undefined,
    last: undefined,
    item: undefined,
  });
  element = document.createElement('div');
  document.body.append(element);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  // Every screen a test left goes with its tab.
  useCrew.setState({ sessionId: 'atlas', tabs: [], following: undefined });
  await vi.dynamicImportSettled();
  element.remove();
});

it('opens a shell beside the conversation in a tab of its own, numbered after the first', async () => {
  await show([], ['first', 'second']);

  await press('Terminal');
  expect(api.openTerminal).toHaveBeenCalledWith('mia', {
    sessionId: 'atlas',
    cols: expect.any(Number),
    rows: expect.any(Number),
  });
  expect(inTabs()).toEqual(['Terminal']);
  expect(element.querySelector('[data-terminal]')).not.toBeNull();

  await act(async () => openTerminalTab());
  await settle();
  expect(inTabs()).toEqual(['Terminal', 'Terminal 2']);
  expect(crew().following).toBe('terminal:second');
  expect(toast.error).not.toHaveBeenCalled();
});

it('says why, and opens no tab, when the gateway starts no shell', async () => {
  await show([]);

  await press('Terminal');

  expect(toast.error).toHaveBeenCalledWith('This gateway already has 12 terminals open.');
  expect(crew().tabs).toEqual([]);
});

it('ends the shell with its tab, and leaves it running behind a conversation left for another', async () => {
  await show([terminal('closed'), terminal('kept')]);

  await act(async () =>
    element.querySelector<HTMLButtonElement>('[aria-label="Close Terminal tab"]')?.click(),
  );
  expect(api.closeTerminal).toHaveBeenCalledWith('mia', 'closed');
  expect(inTabs()).toEqual(['Terminal']);

  await act(async () => crew().show('nova', []));
  expect(api.closeTerminal).toHaveBeenCalledTimes(1);

  // Back to it: the tab was saved with its conversation, and its shell was never told to end.
  await act(async () => crew().show('atlas', []));
  expect(crew().tabs).toEqual([terminal('kept')]);
});

it('ends a terminal opened in a new chat that was left before its first message', async () => {
  useCrew.setState({ sessionId: undefined });
  await show([terminal('unsaved')]);

  await act(async () => crew().show('nova', []));

  expect(api.closeTerminal).toHaveBeenCalledWith('mia', 'unsaved');
});

it('says a terminal the gateway no longer has ended, and opens a new one in its tab', async () => {
  await show([terminal('lost-one'), page, terminal('lost-two')], ['fresh']);
  expect(said()).toContain('This terminal has ended');

  await press('New terminal');

  expect(crew().tabs.map((tab) => tab.key)).toEqual([
    'terminal:lost-one',
    'browser:one',
    'terminal:fresh',
  ]);
  expect(crew().following).toBe('terminal:fresh');
  expect(said()).toBe('');
});

it('offers to start again where the shell exited', async () => {
  await show([terminal('done-one')], ['again']);
  expect(said()).toContain('The shell exited with code 2.');

  await press('Restart');

  expect(crew().tabs).toEqual([terminal('again')]);
  expect(said()).toBe('');
});

it('leaves Escape to the shell while a key is pressed in the terminal', async () => {
  await show([terminal('running')]);
  const pressed = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });

  await act(async () => element.querySelector('[data-terminal]')?.dispatchEvent(pressed()));
  expect(crew().opened).toBe(true);

  await act(async () => document.body.dispatchEvent(pressed()));
  expect(crew().opened).toBe(false);
});

it('keeps a terminal tab with its conversation across a reload', async () => {
  vi.useFakeTimers();
  try {
    crew().show('saved-chat', []);
    crew().openTerminal('kept-shell');
    vi.advanceTimersByTime(400);
  } finally {
    vi.useRealTimers();
  }

  // A new store, as a new launch has, reading only what was written down.
  vi.resetModules();
  const { useCrew: reopened } = await import('../../../lib/stores/crew');
  reopened.getState().show('saved-chat', []);

  expect(reopened.getState().tabs).toEqual([terminal('kept-shell')]);
  expect(reopened.getState().following).toBe('terminal:kept-shell');
});

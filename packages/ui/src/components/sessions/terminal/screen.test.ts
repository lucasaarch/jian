import { TERMINAL_SCROLLBACK } from '@jian/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import type { TerminalApi } from './link';

const library = vi.hoisted(() => ({ fails: false, written: [] as string[] }));
vi.mock('@xterm/xterm', () => {
  if (library.fails) throw new Error('Failed to fetch dynamically imported module');
  return {
    Terminal: class {
      element = undefined;
      options = {};
      loadAddon() {}
      onData() {}
      onResize() {}
      attachCustomKeyEventHandler() {}
      write(data: string) {
        library.written.push(data);
      }
      reset() {}
      dispose() {}
    },
  };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));

type Handlers = Parameters<TerminalApi['terminalOutput']>[2];

function shell() {
  const stream: { handlers?: Handlers; signal?: AbortSignal } = {};
  const api = {
    terminalOutput: (
      _profile: string,
      _terminal: string,
      handlers: Handlers,
      signal: AbortSignal,
    ) => {
      stream.handlers = handlers;
      stream.signal = signal;
      return new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  } as unknown as TerminalApi;
  return { api, stream };
}

afterEach(() => {
  vi.resetModules();
  library.fails = false;
  library.written = [];
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

it('stops reading a shell it can never draw once its library failed to load', async () => {
  library.fails = true;
  const { terminalScreen } = await import('./screen');
  const { api, stream } = shell();

  const screen = terminalScreen(api, 'mia', 'lost');
  stream.handlers?.opened();
  stream.handlers?.output('$ make\r\n');
  await settled();

  expect(stream.signal?.aborted).toBe(true);
  screen.dispose();
});

it('holds no more than the scrollback while the library loads, its latest output', async () => {
  const { terminalScreen } = await import('./screen');
  const { api, stream } = shell();

  const screen = terminalScreen(api, 'mia', 'busy');
  stream.handlers?.opened();
  stream.handlers?.output('x'.repeat(TERMINAL_SCROLLBACK));
  stream.handlers?.output('the end');
  await settled();

  expect(library.written).toHaveLength(1);
  expect(library.written[0]).toHaveLength(TERMINAL_SCROLLBACK);
  expect(library.written[0]?.endsWith('the end')).toBe(true);
  screen.dispose();
});

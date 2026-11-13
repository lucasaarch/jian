import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GatewayAnswer } from '../../../lib/api/result';
import { linkTerminal, type TerminalApi } from './link';

type Handlers = Parameters<TerminalApi['terminalOutput']>[2];

/** A gateway whose streams and writes end when the test says so. */
function gateway() {
  const streams: { handlers: Handlers; end(): void; fail(error: unknown): void }[] = [];
  const writes: string[] = [];
  const sizes: { cols: number; rows: number }[] = [];
  const pending: (() => void)[] = [];
  let flying = 0;
  let most = 0;

  const api = {
    writeTerminal: async (_profile: string, _terminal: string, data: string) => {
      writes.push(data);
      flying += 1;
      most = Math.max(most, flying);
      await new Promise<void>((resolve) => pending.push(resolve));
      flying -= 1;
    },
    resizeTerminal: async (_profile: string, _terminal: string, size: (typeof sizes)[number]) => {
      sizes.push(size);
    },
    terminalOutput: (_profile: string, _terminal: string, handlers: Handlers) =>
      new Promise<void>((end, fail) => streams.push({ handlers, end, fail })),
  } as unknown as TerminalApi;

  return {
    api,
    streams,
    writes,
    sizes,
    answer: () => pending.shift()?.(),
    most: () => most,
  };
}

/** What the screen shows: everything written since it was last cleared. */
function surface() {
  let text = '';
  return {
    write: (data: string) => {
      text += data;
    },
    reset: () => {
      text = '';
    },
    text: () => text,
  };
}

const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('sends what was typed in the order it was typed, one request at a time', async () => {
  const { api, streams, writes, answer, most } = gateway();
  const link = linkTerminal(api, 'mia', 'one', surface());
  streams[0]?.handlers.opened();

  link.send('l');
  link.send('s');
  await later(20);
  expect(writes).toEqual(['ls']);

  // The gateway has not answered the first yet: what comes meanwhile waits behind it.
  link.send('\r');
  await later(20);
  link.send('pwd');
  await later(20);
  expect(writes).toEqual(['ls']);

  answer();
  await later(20);
  expect(writes).toEqual(['ls', '\rpwd']);
  expect(most()).toBe(1);
  link.stop();
});

it('starts the screen over with what the gateway kept when its stream comes back', async () => {
  const { api, streams } = gateway();
  const screen = surface();
  const link = linkTerminal(api, 'mia', 'one', screen);
  expect(link.state()).toEqual({ status: 'connecting' });

  streams[0]?.handlers.opened();
  streams[0]?.handlers.output('$ make\r\n');
  expect(link.state()).toEqual({ status: 'open' });

  streams[0]?.end();
  await later(0);
  expect(link.state()).toEqual({ status: 'away' });

  await later(1000);
  expect(streams).toHaveLength(2);
  streams[1]?.handlers.opened();
  streams[1]?.handlers.output('$ make\r\ndone\r\n');

  // Not the first lines twice: the replay is the whole of it.
  expect(screen.text()).toBe('$ make\r\ndone\r\n');
  expect(link.state()).toEqual({ status: 'open' });
  link.stop();
});

it('keeps trying a gateway that cannot be reached, and gives up on a terminal it does not have', async () => {
  const { api, streams, writes } = gateway();
  const link = linkTerminal(api, 'mia', 'one', surface());

  streams[0]?.fail(new TypeError('Failed to fetch'));
  await later(1000);
  expect(streams).toHaveLength(2);

  streams[1]?.fail(new GatewayAnswer('The terminal is not available.', 404));
  await later(0);
  expect(link.state()).toEqual({ status: 'gone' });

  link.send('ls\r');
  await later(60_000);
  expect(streams).toHaveLength(2);
  expect(writes).toEqual([]);
  link.stop();
});

it('says how the shell ended, and takes no more keys for it', async () => {
  const { api, streams, writes } = gateway();
  const screen = surface();
  const link = linkTerminal(api, 'mia', 'one', screen);
  const told = vi.fn();
  link.subscribe(told);

  streams[0]?.handlers.opened();
  streams[0]?.handlers.output('$ exit 3\r\n');
  streams[0]?.handlers.exit(3);
  streams[0]?.end();
  await later(0);

  expect(link.state()).toEqual({ status: 'exited', exitCode: 3 });
  expect(told).toHaveBeenCalled();
  expect(screen.text()).toContain('$ exit 3');
  expect(screen.text()).toContain('[Process exited with code 3]');

  link.send('ls\r');
  await later(60_000);
  expect(writes).toEqual([]);
  expect(streams).toHaveLength(1);
});

it('tells the shell the size a resize settled at, not each one on the way', async () => {
  const { api, streams, sizes } = gateway();
  const link = linkTerminal(api, 'mia', 'one', surface());
  streams[0]?.handlers.opened();

  link.resize({ cols: 90, rows: 30 });
  await later(40);
  link.resize({ cols: 100, rows: 30 });
  await later(40);
  link.resize({ cols: 120, rows: 32 });
  await later(500);

  expect(sizes).toEqual([{ cols: 120, rows: 32 }]);
  link.stop();
});

import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { MCPClient } from '@ai-sdk/mcp';
import type { Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { connectMcpTools } from '../src/agent/mcp.js';
import * as connection from '../src/agent/mcp-connect.js';
import { stdioTransport } from '../src/agent/mcp-stdio.js';

vi.mock('node:child_process', { spy: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(names = ['one']) {
  const clients: MCPClient[] = [];
  const controller = new AbortController();
  const run = {
    profileId: 'p',
    profile: { mcpServers: names.map((name) => ({ name, transport: 'http' })) },
  } as unknown as Run;
  const context = {
    clients,
    signal: controller.signal,
    secrets: new Set<string>(),
    vault: undefined,
    fetcher: globalThis.fetch,
  };
  return { run, context, clients, controller };
}

function client(tools = vi.fn(async (): Promise<ToolSet> => ({})), close = vi.fn(async () => {})) {
  return { tools, close } as unknown as MCPClient;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('registers an acquired client before listing and retains it if listing or close fails', async () => {
  const fixture = setup();
  const listing = deferred<ToolSet>();
  const acquired = client(
    vi.fn(() => listing.promise),
    vi.fn(async () => {
      throw new Error('uncertain close');
    }),
  );
  vi.spyOn(connection, 'connectMcp').mockResolvedValue(acquired);
  const opening = connectMcpTools(fixture.run, {}, fixture.context);
  await vi.waitFor(() => expect(fixture.clients).toEqual([acquired]));
  listing.reject(new Error('listing failed'));
  expect((await opening).unavailable).toEqual([{ name: 'one', reason: 'listing failed' }]);
  // These are the exact handles consumed by runtime's allSettled cleanup. A rejection must
  // remain visible there so releaseExecution cannot clear the durable execution marker.
  expect((await Promise.allSettled(fixture.clients.map((item) => item.close())))[0]?.status).toBe(
    'rejected',
  );
  expect(fixture.clients).toEqual([acquired]);
});

it('waits for all partial opens after abort before handing ownership back to runtime', async () => {
  const fixture = setup(['fast', 'slow']);
  const listing = deferred<ToolSet>();
  const late = deferred<MCPClient>();
  const first = client(vi.fn(() => listing.promise));
  const second = client();
  vi.spyOn(connection, 'connectMcp').mockResolvedValueOnce(first).mockReturnValueOnce(late.promise);
  let returned = false;
  const opening = connectMcpTools(fixture.run, {}, fixture.context).finally(() => {
    returned = true;
  });
  // Attach a handler before abort, avoiding an unhandled rejection in the regression test.
  const rejected = expect(opening).rejects.toThrow('stop');
  await vi.waitFor(() => expect(fixture.clients).toEqual([first]));
  fixture.controller.abort(new Error('stop'));
  listing.reject(new Error('aborted listing'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(returned).toBe(false);
  late.resolve(second);
  await rejected;
  expect(fixture.clients).toEqual([first, second]);
  await Promise.all(fixture.clients.map((item) => item.close()));
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).toHaveBeenCalledOnce();
});

it('retains both acquired clients when reconnect cannot confirm the old client closed', async () => {
  const fixture = setup();
  const remote = tool({
    inputSchema: z.object({}),
    execute: async (): Promise<string> => {
      throw new Error('Attempted to send a request from a closed client');
    },
  });
  const old = client(
    vi.fn(async () => ({ action: remote })),
    vi.fn(async () => {
      throw new Error('old close failed');
    }),
  );
  const replacement = client(vi.fn(async () => ({ action: remote })));
  vi.spyOn(connection, 'connectMcp').mockResolvedValueOnce(old).mockResolvedValueOnce(replacement);
  const tools: ToolSet = {};
  const result = await connectMcpTools(fixture.run, tools, fixture.context);
  const execute = tools[result.mcpToolNames[0] ?? '']?.execute as
    | ((
        input: Record<string, never>,
        options: { toolCallId: string; messages: [] },
      ) => Promise<unknown>)
    | undefined;
  expect(execute).toBeDefined();
  await expect(execute?.({}, { toolCallId: 'call', messages: [] })).rejects.toThrow(
    'old close failed',
  );
  expect(fixture.clients).toEqual([old, replacement]);
  const closed = await Promise.allSettled(fixture.clients.map((item) => item.close()));
  expect(closed.map((item) => item.status)).toEqual(['rejected', 'fulfilled']);
  expect(old.close).toHaveBeenCalledTimes(2);
  expect(replacement.close).toHaveBeenCalledOnce();
});

it.each(['slow', 'ignore'] as const)(
  'waits for observed stdio termination (%s SIGTERM)',
  async (mode) => {
    const ready = deferred<number>();
    const transport = stdioTransport({
      command: process.execPath,
      args: [
        '-e',
        `
      process.on('SIGTERM', () => { ${mode === 'slow' ? 'setTimeout(() => process.exit(0), 150);' : ''} });
      setInterval(() => {}, 1000);
      console.log(JSON.stringify({ pid: process.pid }));
    `,
      ],
      env: {},
      signal: new AbortController().signal,
    });
    transport.onmessage = (message) => ready.resolve((message as unknown as { pid: number }).pid);
    let pid: number | undefined;
    try {
      await transport.start();
      pid = await ready.promise;
      const before = Date.now();
      await transport.close();
      expect(Date.now() - before).toBeGreaterThanOrEqual(mode === 'slow' ? 100 : 900);
      expect(() => process.kill(pid as number, 0)).toThrow();
      await transport.close();
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already confirmed dead. */
        }
      }
    }
  },
);

it('rejects unconfirmed stdio cleanup and retains the handle for a later confirmation', async () => {
  vi.useFakeTimers();
  const fake = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    stdout: undefined,
    stderr: undefined,
  });
  vi.mocked(childProcess.spawn).mockReturnValueOnce(
    fake as unknown as ReturnType<typeof childProcess.spawn>,
  );
  const transport = stdioTransport({
    command: 'fake',
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  await transport.start();
  const closing = transport.close();
  const rejected = expect(closing).rejects.toThrow('termination could not be confirmed');
  await vi.advanceTimersByTimeAsync(2_000);
  await rejected;
  expect(fake.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  const retry = transport.close();
  expect(fake.kill).toHaveBeenCalledTimes(3);
  fake.emit('close', 0, null);
  await retry;
  await transport.close();
  expect(fake.kill).toHaveBeenCalledTimes(3);
});

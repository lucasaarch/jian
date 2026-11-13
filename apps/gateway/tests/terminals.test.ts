import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINALS_MAX, terminalSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { sessionWorktrees } from '../src/storage/schema.js';
import { type PtyProcess, ptyModule, type SpawnPty } from '../src/terminals/pty.js';
import { testServices } from './helpers/services.js';

const root = mkdtempSync(join(tmpdir(), 'jian-terminals-'));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;
afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const token = 'synthetic-admin-token-with-32-characters';
const headers = { authorization: `Bearer ${token}` };
const size = { cols: 80, rows: 24 };

/** A shell that starts no process: what it was started with, and the two ends a test drives. */
type FakeShell = PtyProcess & {
  cwd: string;
  written: string[];
  killed: boolean;
  print(data: string): void;
  exit(exitCode: number): void;
};

function fakeShells() {
  const shells: FakeShell[] = [];
  const spawn: SpawnPty = async (_file, _args, options) => {
    const data: ((data: string) => void)[] = [];
    const exits: ((event: { exitCode: number }) => void)[] = [];
    const shell: FakeShell = {
      pid: 0,
      cwd: options.cwd,
      written: [],
      killed: false,
      write: (text) => void shell.written.push(text),
      resize: () => {},
      kill: () => {
        shell.killed = true;
      },
      onData: (listener) => data.push(listener),
      onExit: (listener) => exits.push(listener),
      print: (text) => {
        for (const listener of data) listener(text);
      },
      exit: (exitCode) => {
        for (const listener of exits) listener({ exitCode });
      },
    };
    shells.push(shell);
    return shell;
  };

  return { shells, spawn };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(spawnTerminal?: SpawnPty) {
  const services = await testServices();
  const app = createApp({ ...services, token, logger: false, spawnTerminal });
  apps.push(app);
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
  const at = (profileId: string, rest = '') => `/v1/profiles/${profileId}/terminals${rest}`;
  const open = (profileId: string, body: object = size) =>
    app.inject({ method: 'POST', url: at(profileId), headers, payload: body });

  return { services, app, owner, other, at, open };
}

/** A terminal's stream, read as far as a test asks; ten seconds is the most it waits. */
async function openStream(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  });
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');

  return {
    /** Everything read once `done` says it is enough, or the stream has ended. */
    async until(done: (text: string) => boolean): Promise<string> {
      while (reader && !done(text)) {
        const { done: ended, value } = await reader.read();
        if (ended) break;
        text += value;
      }

      return text;
    },
    close: () => controller.abort(),
  };
}

/** What the `output` frames of a stream carried, in order. */
const printed = (text: string) =>
  text
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: output\n'))
    .map((frame) => (JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as { data: string }).data)
    .join('');

describe('terminals', () => {
  it('refuses every route to a caller with no token', async () => {
    const { app, owner, at } = await setup(fakeShells().spawn);
    const terminal = `/${randomUUID()}`;
    const routes = [
      { method: 'GET', url: at(owner.id) },
      { method: 'POST', url: at(owner.id), payload: size },
      { method: 'GET', url: at(owner.id, `${terminal}/stream`) },
      { method: 'POST', url: at(owner.id, `${terminal}/input`), payload: { data: 'ls\r' } },
      { method: 'POST', url: at(owner.id, `${terminal}/resize`), payload: size },
      { method: 'DELETE', url: at(owner.id, terminal) },
    ] as const;

    for (const route of routes) {
      expect((await app.inject(route)).statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it("keeps a terminal to its profile: another profile's id is not found", async () => {
    const { shells, spawn } = fakeShells();
    const { services, app, owner, other, at, open } = await setup(spawn);
    const session = await services.sessions.createGatewaySession(owner.id, {});
    const opened = await open(owner.id, { ...size, sessionId: session.id });

    expect(opened.statusCode).toBe(201);
    const terminal = terminalSchema.parse(opened.json());
    expect(terminal.sessionId).toBe(session.id);

    const mine = await app.inject({ url: at(owner.id), headers });
    expect(mine.json()).toEqual([terminal]);
    expect((await app.inject({ url: at(other.id), headers })).json()).toEqual([]);

    const id = `/${terminal.id}`;
    for (const route of [
      { method: 'GET', url: at(other.id, `${id}/stream`) },
      { method: 'POST', url: at(other.id, `${id}/input`), payload: { data: 'whoami\r' } },
      { method: 'POST', url: at(other.id, `${id}/resize`), payload: size },
      { method: 'DELETE', url: at(other.id, id) },
    ] as const) {
      const response = await app.inject({ ...route, headers });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
    }

    // Nor does another profile open one beside a conversation that is not its own.
    expect((await open(other.id, { ...size, sessionId: session.id })).statusCode).toBe(404);
    expect(shells).toHaveLength(1);
    expect(shells[0]?.written).toEqual([]);
    expect(shells[0]?.killed).toBe(false);

    const written = await app.inject({
      method: 'POST',
      url: at(owner.id, `${id}/input`),
      headers,
      payload: { data: 'whoami\r' },
    });
    expect(written.statusCode).toBe(204);
    expect(shells[0]?.written).toEqual(['whoami\r']);
  });

  it('opens no more than the limit across the gateway, and frees a place on close', async () => {
    const { shells, spawn } = fakeShells();
    const { app, owner, other, at, open } = await setup(spawn);
    // All at once: the limit must hold for requests that arrive together too.
    const all = await Promise.all(
      Array.from({ length: TERMINALS_MAX + 3 }, (_, index) =>
        open(index % 2 ? owner.id : other.id),
      ),
    );
    const codes = all.map((response) => response.statusCode);

    expect(codes.filter((code) => code === 201)).toHaveLength(TERMINALS_MAX);
    expect(codes.filter((code) => code === 429)).toHaveLength(3);
    expect(shells).toHaveLength(TERMINALS_MAX);
    expect((await open(owner.id)).statusCode).toBe(429);

    const [first] = (await app.inject({ url: at(owner.id), headers })).json() as { id: string }[];
    const closed = await app.inject({
      method: 'DELETE',
      url: at(owner.id, `/${first?.id}`),
      headers,
    });
    expect(closed.statusCode).toBe(204);
    expect(shells.filter((shell) => shell.killed)).toHaveLength(1);
    expect((await open(other.id)).statusCode).toBe(201);
  });

  it('starts in the worktree of its conversation, and never outside the shared directory', async () => {
    const { shells, spawn } = fakeShells();
    const { services, owner, open } = await setup(spawn);
    const home = realpathSync(root);
    const path = join(home, 'worktrees', `calm-otter-${randomUUID().slice(0, 8)}`);
    mkdirSync(path, { recursive: true });
    const conversation = async (name: string, place: string) => {
      const session = await services.sessions.createGatewaySession(owner.id, {});
      await services.store.db.insert(sessionWorktrees).values({
        id: randomUUID(),
        profileId: owner.id,
        sessionId: session.id,
        name,
        branch: `jian/${name}`,
        base: 'main',
        source: home,
        path: place,
        place: 'gateway',
      });
      return (await open(owner.id, { ...size, sessionId: session.id })).json();
    };

    expect(await conversation('calm-otter', path)).toMatchObject({ cwd: path });
    expect(shells.at(-1)?.cwd).toBe(path);
    // A folder that exists, recorded outside what a server's commands may touch.
    expect(await conversation('stray-heron', '/etc')).toMatchObject({ cwd: home });
    expect((await open(owner.id)).json()).toMatchObject({ cwd: home });
  });

  it('replays what was printed to a stream that opens later, and keeps an ended shell until closed', async () => {
    const { shells, spawn } = fakeShells();
    const { app, owner, at, open } = await setup(spawn);
    const terminal = terminalSchema.parse((await open(owner.id)).json());
    const [shell] = shells;
    const url = `${await app.listen({ host: '127.0.0.1', port: 0 })}${at(owner.id, `/${terminal.id}`)}`;

    shell?.print('first line\r\n');
    shell?.print('second \u001b[1mline\u001b[0m\r\n');

    const stream = await openStream(`${url}/stream`);
    // The scrollback is one frame, however many chunks it arrived in.
    const replayed = await stream.until((text) => text.includes('second'));
    expect(replayed.split('event: output\n')).toHaveLength(2);

    shell?.print('third line\r\n');
    shell?.exit(7);

    // The stream ends by itself after the exit: there is nothing more to wait for.
    const text = await stream.until(() => false);
    expect(printed(text)).toBe('first line\r\nsecond \u001b[1mline\u001b[0m\r\nthird line\r\n');
    expect(text).toContain('event: exit\ndata: {"exitCode":7}\n\n');

    expect((await app.inject({ url: at(owner.id), headers })).json()).toEqual([
      { ...terminal, exitCode: 7 },
    ]);
    const late = await (await openStream(`${url}/stream`)).until(() => false);
    expect(printed(late)).toContain('third line');
    expect(late).toContain('event: exit\ndata: {"exitCode":7}\n\n');
    const refused = await app.inject({
      method: 'POST',
      url: at(owner.id, `/${terminal.id}/input`),
      headers,
      payload: { data: 'ls\r' },
    });
    expect(refused.statusCode).toBe(409);
  });

  it('ends every shell, and the streams reading them, when the gateway closes', async () => {
    const { shells, spawn } = fakeShells();
    const { app, owner, other, at, open } = await setup(spawn);
    const terminal = terminalSchema.parse((await open(owner.id)).json());

    await open(other.id);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const stream = await openStream(`${url}${at(owner.id, `/${terminal.id}/stream`)}`);
    await stream.until((text) => text.includes(': connected'));
    // An open stream is a request in flight: closing must end it, not wait for it.
    await app.close();

    expect(shells.map((shell) => shell.killed)).toEqual([true, true]);
    expect(await stream.until(() => false)).not.toContain('event: exit');
  });
});

const loads = await ptyModule().then(
  () => true,
  () => false,
);

describe('a real shell', () => {
  // Without the prebuilt binary for this platform and CPU there is no shell to drive.
  it.skipIf(!loads)(
    'runs what is typed, streams what it prints, and is gone once closed',
    async () => {
      const { app, owner, at, open } = await setup();
      const opened = await open(owner.id);

      expect(opened.statusCode).toBe(201);
      const terminal = terminalSchema.parse(opened.json());
      expect(terminal.cwd).toBe(realpathSync(root));

      const url = `${await app.listen({ host: '127.0.0.1', port: 0 })}${at(owner.id, `/${terminal.id}`)}`;
      const type = (data: string) =>
        fetch(`${url}/input`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ data }),
        });

      // The arithmetic tells the command's own output from the echo of what was typed.
      expect((await type('echo synthetic-$((40+2))-marker pid-$$-end\r')).status).toBe(204);
      const stream = await openStream(`${url}/stream`);
      const text = printed(
        // A frame is whole once the blank line after it has arrived.
        await stream.until((value) => /synthetic-42-marker pid-\d+-end[\s\S]*\n\n$/.test(value)),
      );
      stream.close();
      const pid = Number(/synthetic-42-marker pid-(\d+)-end/.exec(text)?.[1]);

      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).not.toThrow();

      expect((await fetch(url, { method: 'DELETE', headers })).status).toBe(204);
      expect((await fetch(`${url}/stream`, { headers })).status).toBe(404);
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return 'running';
            } catch {
              return 'gone';
            }
          },
          { timeout: 8000 },
        )
        .toBe('gone');
    },
    20_000,
  );
});

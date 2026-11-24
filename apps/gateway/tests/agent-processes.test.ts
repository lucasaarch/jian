import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_PROCESSES_ENDED_KEPT,
  AGENT_PROCESSES_RUNNING_MAX,
  agentProcessSchema,
  TERMINALS_MAX,
} from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { shellTools } from '../src/agent/shell.js';
import { createApp } from '../src/app.js';
import { streamMask } from '../src/terminals/mask.js';
import { type PtyProcess, ptyModule, type SpawnPty } from '../src/terminals/pty.js';
import { Terminals } from '../src/terminals/service.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-processes-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;
afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const token = 'synthetic-admin-token-with-32-characters';
const headers = { authorization: `Bearer ${token}` };
const SECRET = 'synthetic-secret-value-7f3a9c';

type FakeShell = PtyProcess & {
  signals: (string | undefined)[];
  print(data: string): void;
  exit(exitCode: number, signal?: number): void;
};

/** Shells that start no process; a signal to one ends it, as a real one would. */
function fakeShells() {
  const shells: FakeShell[] = [];
  const spawn: SpawnPty = async () => {
    const data: ((data: string) => void)[] = [];
    const exits: ((event: { exitCode: number; signal?: number }) => void)[] = [];
    let ended = false;
    const shell: FakeShell = {
      pid: 0,
      signals: [],
      write: () => {},
      resize: () => {},
      kill: (signal) => {
        shell.signals.push(signal);
        queueMicrotask(() => shell.exit(0, 15));
      },
      onData: (listener) => data.push(listener),
      onExit: (listener) => exits.push(listener),
      print: (text) => {
        for (const listener of data) listener(text);
      },
      exit: (exitCode, signal) => {
        if (ended) return;
        ended = true;
        for (const listener of exits) listener({ exitCode, ...(signal ? { signal } : {}) });
      },
    };
    shells.push(shell);
    return shell;
  };

  return { shells, spawn };
}

const start = (command = 'sleep 100', secrets: ReadonlySet<string> = new Set()) => ({
  command,
  cwd: root,
  file: '/bin/sh',
  args: ['-c', command],
  env: {},
  secrets,
});

describe('masking a stream that arrives in pieces', () => {
  const secrets = new Set([SECRET]);

  it('never shows a value split across two pieces, or the half of it', () => {
    const mask = streamMask(secrets);
    const shown: string[] = [];

    for (const piece of ['token=synthetic-sec', 'ret-value-', '7f3a9c done\n']) {
      shown.push(mask.push(piece));
    }
    shown.push(mask.end());

    expect(shown.join('')).toBe('token=[REDACTED] done\n');
    // The first piece ends in the start of a value: only its tail waits.
    expect(shown[0]).toBe('token=');
  });

  it('holds back nothing that cannot be the start of a value', () => {
    const mask = streamMask(secrets);

    expect(mask.push('Listening on port 3000\n')).toBe('Listening on port 3000\n');
    expect(mask.end()).toBe('');
  });

  it('shows what was held when the output ends', () => {
    const mask = streamMask(secrets);

    expect(mask.push('ends like a value: synthetic-sec')).toBe('ends like a value: ');
    expect(mask.end()).toBe('synthetic-sec');
  });
});

describe('the agent’s background commands', () => {
  it('keeps them to the profile and the conversation that started them', async () => {
    const { spawn } = fakeShells();
    const terminals = new Terminals(spawn);
    const [owner, other] = [randomUUID(), randomUUID()];
    const [here, elsewhere] = [randomUUID(), randomUUID()];
    const started = await terminals.startProcess(owner, here, start());

    expect(agentProcessSchema.parse(started)).toMatchObject({ status: 'running', sessionId: here });
    expect(terminals.processes(owner, here)).toHaveLength(1);
    expect(terminals.processes(owner, elsewhere)).toEqual([]);
    expect(terminals.processes(other)).toEqual([]);
    expect(() => terminals.processOutput(other, started.id)).toThrow('Process not found');
    expect(() => terminals.watch(other, started.id, () => {})).toThrow('Terminal not found');
    await expect(terminals.stopProcess(other, started.id)).rejects.toThrow('Process not found');
    // Another conversation's id is not found either, where the conversation is named.
    await expect(terminals.stopProcess(owner, started.id, elsewhere)).rejects.toThrow(
      'Process not found',
    );
    expect(terminals.processes(owner, here)[0]?.status).toBe('running');
  });

  it('refuses a ninth running command, counted across commands started together', async () => {
    const { spawn } = fakeShells();
    const terminals = new Terminals(spawn);
    const profile = randomUUID();
    const session = randomUUID();

    const together = await Promise.allSettled(
      Array.from({ length: AGENT_PROCESSES_RUNNING_MAX + 2 }, () =>
        terminals.startProcess(profile, session, start()),
      ),
    );

    expect(together.filter((item) => item.status === 'fulfilled')).toHaveLength(
      AGENT_PROCESSES_RUNNING_MAX,
    );
    expect(together.filter((item) => item.status === 'rejected')).toHaveLength(2);
    await expect(terminals.startProcess(profile, session, start())).rejects.toThrow(
      /already running/,
    );

    // Another profile has its own eight, and the owner's terminals are not touched by them.
    await terminals.startProcess(randomUUID(), session, start());
    expect(terminals.list(profile)).toEqual([]);
  });

  it('keeps the record of an ended command, and the twenty most recent of a profile', async () => {
    const { shells, spawn } = fakeShells();
    const terminals = new Terminals(spawn);
    const profile = randomUUID();
    const session = randomUUID();
    const ids: string[] = [];

    for (let index = 0; index < AGENT_PROCESSES_ENDED_KEPT + 3; index += 1) {
      const one = await terminals.startProcess(profile, session, start(`job ${index}`));
      ids.push(one.id);
      shells.at(-1)?.print(`out ${index}\n`);
      shells.at(-1)?.exit(index % 2);
    }

    const kept = terminals.processes(profile);
    expect(kept.map((item) => item.id)).toEqual(ids.slice(3));
    expect(kept.at(-1)).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(terminals.processOutput(profile, ids.at(-1) ?? '').output).toContain('out 22');
    expect(() => terminals.processOutput(profile, ids[0] ?? '')).toThrow('Process not found');
  });

  it('tells a command asked to stop from one that ended on its own, and ends them all with the gateway', async () => {
    const { shells, spawn } = fakeShells();
    const terminals = new Terminals(spawn);
    const profile = randomUUID();
    const session = randomUUID();
    const [one, two] = [
      await terminals.startProcess(profile, session, start()),
      await terminals.startProcess(profile, session, start()),
    ];

    shells[1]?.exit(4);
    expect(await terminals.stopProcess(profile, one.id)).toMatchObject({
      status: 'stopped',
      exitCode: 143,
    });
    expect(terminals.processes(profile).find((item) => item.id === two.id)).toMatchObject({
      status: 'exited',
      exitCode: 4,
    });

    const third = await terminals.startProcess(profile, session, start());
    await terminals.closeAll();
    expect(shells[2]?.signals.length).toBeGreaterThan(0);
    expect(terminals.processes(profile)).toEqual([]);
    expect(() => terminals.processOutput(profile, third.id)).toThrow('Process not found');
  });

  it('ends a conversation’s commands with the conversation, and leaves the others', async () => {
    const { shells, spawn } = fakeShells();
    const terminals = new Terminals(spawn);
    const profile = randomUUID();
    const [gone, kept] = [randomUUID(), randomUUID()];

    await terminals.startProcess(profile, gone, start());
    await terminals.startProcess(profile, kept, start());
    await terminals.forgetSession(profile, gone);

    expect(shells[0]?.signals.length).toBeGreaterThan(0);
    expect(shells[1]?.signals).toEqual([]);
    expect(terminals.processes(profile).map((item) => item.sessionId)).toEqual([kept]);
  });

  it('tells the panel when one starts and ends', async () => {
    const { shells, spawn } = fakeShells();
    const told: string[] = [];
    const terminals = new Terminals(spawn, Date.now, (_profile, news) => told.push(news.type));

    await terminals.startProcess(randomUUID(), randomUUID(), start());
    shells[0]?.exit(0);

    expect(told).toEqual(['process.started', 'process.ended']);
  });
});

describe('what the agent is offered', () => {
  it('has background commands only where the gateway can keep them', () => {
    const without = shellTools();
    const none = without.run_command as { description: string };

    expect(Object.keys(without)).not.toContain('process_output');
    expect(Object.keys(without)).not.toContain('stop_process');
    expect(none.description).not.toContain('background');

    const offered = shellTools(undefined, undefined, {
      processes: new Terminals(fakeShells().spawn),
      profileId: randomUUID(),
      sessionId: randomUUID(),
    });
    expect(Object.keys(offered)).toEqual(
      expect.arrayContaining(['run_command', 'process_output', 'stop_process']),
    );
    expect((offered.run_command as { description: string }).description).toContain('background');
  });
});

describe('the routes of the agent’s commands', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function setup() {
    const { shells, spawn } = fakeShells();
    const terminals = new Terminals(spawn);
    const services = await testServices();
    const app = createApp({ ...services, token, logger: false, terminals });
    apps.push(app);
    const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
    const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const session = await services.sessions.createSession(owner.id, { title: 'Work' });
    const base = (profileId: string) => `/v1/profiles/${profileId}`;
    const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

    return { app, shells, terminals, services, owner, other, session, base, call };
  }

  it('lists a conversation’s commands and stops one; another profile finds nothing', async () => {
    const { terminals, owner, other, session, base, call } = await setup();
    const one = await terminals.startProcess(owner.id, session.id, start('npm run dev'));
    const at = `${base(owner.id)}/sessions/${session.id}/processes`;

    expect((await call('GET', at)).json()).toEqual([expect.objectContaining({ id: one.id })]);

    // The same ids, under another profile: not found, listed or stopped or streamed.
    const foreign = `${base(other.id)}/sessions/${session.id}/processes`;
    expect((await call('GET', foreign)).statusCode).toBe(404);
    expect((await call('POST', `${foreign}/${one.id}/stop`)).statusCode).toBe(404);
    expect((await call('GET', `${base(other.id)}/terminals/${one.id}/stream`)).statusCode).toBe(
      404,
    );
    expect(terminals.processes(owner.id)[0]?.status).toBe('running');

    const stopped = await call('POST', `${at}/${one.id}/stop`);
    expect(stopped.statusCode).toBe(200);
    expect(agentProcessSchema.parse(stopped.json())).toMatchObject({ status: 'stopped' });
  });

  it('needs the admin token, and a conversation that exists', async () => {
    const { app, owner, session, base, call } = await setup();
    const at = `${base(owner.id)}/sessions/${session.id}/processes`;

    expect((await app.inject({ method: 'GET', url: at })).statusCode).toBe(401);
    expect(
      (await call('GET', `${base(owner.id)}/sessions/${randomUUID()}/processes`)).statusCode,
    ).toBe(404);
  });

  it('shows the owner’s terminal list none of them, and takes no input or close for one', async () => {
    const { app, terminals, owner, session, base, call } = await setup();
    const one = await terminals.startProcess(owner.id, session.id, start());
    const at = `${base(owner.id)}/terminals`;

    expect((await call('GET', at)).json()).toEqual([]);
    expect((await call('POST', `${at}/${one.id}/input`, { data: 'x' })).statusCode).toBe(409);
    expect((await call('POST', `${at}/${one.id}/resize`, { cols: 80, rows: 24 })).statusCode).toBe(
      409,
    );
    expect(
      (await app.inject({ method: 'DELETE', url: `${at}/${one.id}`, headers })).statusCode,
    ).toBe(409);
    expect(terminals.processes(owner.id)[0]?.status).toBe('running');
  });

  it('does not let the commands take the places of the owner’s terminals', async () => {
    const { terminals, owner, session, base, call } = await setup();

    for (let index = 0; index < AGENT_PROCESSES_RUNNING_MAX; index += 1) {
      await terminals.startProcess(owner.id, session.id, start());
    }
    for (let index = 0; index < TERMINALS_MAX; index += 1) {
      expect(
        (await call('POST', `${base(owner.id)}/terminals`, { cols: 80, rows: 24 })).statusCode,
      ).toBe(201);
    }
  });
});

const loads = await ptyModule().then(
  () => true,
  () => false,
);

/** Whether it still runs: a zombie nobody reaps (as in a container with no init) is gone. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    return !readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z');
  } catch {
    return true;
  }
};

describe.skipIf(!loads)('a real command in the background', () => {
  const lend = (value: string) => ({
    offered: [],
    reveal: async () => ({ SYNTHETIC_TOKEN: { value, sensitive: true } }),
    check: async () => {},
  });

  const run = async (
    tools: ReturnType<typeof shellTools>,
    name: string,
    input: object,
  ): Promise<Record<string, unknown>> =>
    (
      tools[name] as unknown as {
        execute: (input: object, options: object) => Promise<Record<string, unknown>>;
      }
    ).execute(input, { toolCallId: 'test', messages: [], context: {} });

  function agent(secrets?: ReturnType<typeof lend>) {
    const terminals = new Terminals();
    const access = { processes: terminals, profileId: randomUUID(), sessionId: randomUUID() };

    return { terminals, access, tools: shellTools(undefined, secrets, access) };
  }

  it('answers at once with what it printed, and is read and stopped by id', async () => {
    const { terminals, access, tools } = agent();
    const started = await run(tools, 'run_command', {
      command: "printf '\\033[32mready\\033[0m\\n'; sleep 60",
      background: true,
    });

    expect(started).toMatchObject({ status: 'running', output: 'ready\n' });
    const processId = String(started.processId);
    const listed = (await run(tools, 'process_output', {})) as { processes: { id: string }[] };

    expect(listed.processes.map((item) => item.id)).toEqual([processId]);
    expect(await run(tools, 'process_output', { processId })).toMatchObject({
      process: { status: 'running' },
      output: 'ready\n',
    });
    expect(await run(tools, 'stop_process', { processId })).toMatchObject({ status: 'stopped' });
    // Kept for reading after it ended.
    expect(await run(tools, 'process_output', { processId })).toMatchObject({
      process: { status: 'stopped' },
      output: 'ready\n',
    });
    await terminals.closeAll();
    expect(access.sessionId).toBeTruthy();
  }, 20_000);

  it('answers with how it ended when it ends at once', async () => {
    const { terminals, tools } = agent();
    const started = await run(tools, 'run_command', {
      command: 'echo nope; exit 3',
      background: true,
    });

    expect(started).toMatchObject({ status: 'exited', exitCode: 3, output: 'nope\n' });
    await terminals.closeAll();
  }, 20_000);

  it('leaves nothing behind when it is stopped: what it started dies with it', async () => {
    const { terminals, tools } = agent();
    const started = await run(tools, 'run_command', {
      command: 'sleep 1000 & echo child=$!; sleep 1000',
      background: true,
    });
    const child = Number(/child=(\d+)/.exec(String(started.output))?.[1]);

    expect(child).toBeGreaterThan(0);
    expect(alive(child)).toBe(true);
    await run(tools, 'stop_process', { processId: started.processId });
    await expect.poll(() => alive(child), { timeout: 8000 }).toBe(false);
    await terminals.closeAll();
  }, 20_000);

  it('masks a lent Secret before it is kept: the scrollback, the stream and the agent see none', async () => {
    const { terminals, access, tools } = agent(lend(SECRET));
    const started = await run(tools, 'run_command', {
      command: 'printf "key=%s\\n" "$SYNTHETIC_TOKEN"; sleep 60',
      secrets: ['SYNTHETIC_TOKEN'],
      background: true,
    });
    const processId = String(started.processId);

    expect(JSON.stringify(started)).not.toContain(SECRET);
    expect(started.output).toBe('key=[REDACTED]\n');

    const watching = terminals.watch(access.profileId, processId, () => {});
    expect(watching.scrollback).toContain('[REDACTED]');
    expect(watching.scrollback).not.toContain(SECRET);
    watching.stop();
    expect(JSON.stringify(await run(tools, 'process_output', { processId }))).not.toContain(SECRET);
    await terminals.closeAll();
  }, 20_000);

  it('refuses ssh-keygen as a command that waits does', async () => {
    const { tools } = agent();

    expect(
      await run(tools, 'run_command', { command: 'ssh-keygen -t ed25519', background: true }),
    ).toMatchObject({ exitCode: 126 });
  });
});

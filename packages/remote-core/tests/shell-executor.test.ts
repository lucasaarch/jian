import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  describeTask,
  executeShellTask,
  formatShellSpawnError,
  resolveShellCwd,
  shellCommandForPlatform,
  workerChildEnv,
} from '../src/index.ts';

test('shellCommandForPlatform uses an absolute POSIX shell', () => {
  assert.equal(shellCommandForPlatform('win32'), 'powershell.exe');
  const unix = shellCommandForPlatform('linux');
  assert.match(unix, /^\/(usr\/)?bin\/(ba)?sh$/);
  assert.equal(existsSync(unix), true);
});

test('resolveShellCwd uses home when cwd is missing or empty', () => {
  const home = '/Users/lucas';
  assert.deepEqual(
    resolveShellCwd(undefined, {
      home,
      exists: (p) => p === home,
      stat: () => ({ isDirectory: () => true }),
    }),
    { cwd: home, note: undefined, usedFallback: false },
  );
  assert.deepEqual(
    resolveShellCwd(null, {
      home,
      exists: (p) => p === home,
      stat: () => ({ isDirectory: () => true }),
    }).cwd,
    home,
  );
  assert.deepEqual(
    resolveShellCwd('', {
      home,
      exists: (p) => p === home,
      stat: () => ({ isDirectory: () => true }),
    }).cwd,
    home,
  );
});

test('resolveShellCwd falls back when the requested path does not exist', () => {
  const home = '/Users/lucas';
  const result = resolveShellCwd('/no/such/remote/cwd', {
    home,
    exists: (p) => p === home,
    stat: (p) => {
      if (p === home) return { isDirectory: () => true };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  });
  assert.equal(result.cwd, home);
  assert.equal(result.usedFallback, true);
  assert.match(result.note ?? '', /does not exist/);
  assert.match(result.note ?? '', /using \/Users\/lucas/);
});

test('resolveShellCwd falls back when the path is a file, not a directory', () => {
  const home = '/Users/lucas';
  const file = '/Users/lucas/notes.txt';
  const result = resolveShellCwd(file, {
    home,
    exists: () => true,
    stat: (p) => ({ isDirectory: () => p === home }),
  });
  assert.equal(result.cwd, home);
  assert.equal(result.usedFallback, true);
  assert.match(result.note ?? '', /not a directory/);
});

test('resolveShellCwd keeps a valid requested directory', () => {
  const home = '/Users/lucas';
  const project = '/Users/lucas/Code/jian';
  const result = resolveShellCwd(project, {
    home,
    exists: () => true,
    stat: () => ({ isDirectory: () => true }),
  });
  assert.deepEqual(result, { cwd: project, note: undefined, usedFallback: false });
});

test('formatShellSpawnError explains cwd ENOENT instead of blaming /bin/sh alone', () => {
  const error = Object.assign(new Error('spawn /bin/sh ENOENT'), { code: 'ENOENT' });
  const message = formatShellSpawnError(error, {
    shell: '/bin/sh',
    cwd: '/Users/lucas',
  });
  assert.match(message, /working directory/i);
  assert.match(message, /\/Users\/lucas/);
  assert.doesNotMatch(message, /^spawn \/bin\/sh ENOENT$/);
});

test('workerChildEnv always sets PATH including /bin and a HOME', () => {
  const env = workerChildEnv({ HOME: '/Users/lucas' });
  assert.match(env.PATH ?? '', /(?:^|:)\/bin(?::|$)/);
  assert.match(env.PATH ?? '', /(?:^|:)\/usr\/bin(?::|$)/);
  assert.equal(env.HOME, '/Users/lucas');
});

test('executeShellTask does not spawn with a missing cwd (avoids libuv ENOENT)', async () => {
  const home = join(tmpdir(), `jian-shell-home-${process.pid}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = home;

  let spawned: { command: string; args: string[]; options: SpawnOptions } | undefined;
  const stdout = new EventEmitter();
  const fakeChild = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new EventEmitter(),
    kill: () => true,
  }) as unknown as ChildProcess;

  try {
    const resultPromise = executeShellTask(
      {
        id: 'task-1',
        command: 'echo ok',
        cwd: join(home, 'does-not-exist'),
        kind: 'shell',
        timeoutMs: 5_000,
      },
      {
        spawnImpl: (command, args, options) => {
          spawned = { command, args, options };
          queueMicrotask(() => {
            stdout.emit('data', Buffer.from('ok\n'));
            fakeChild.emit('close', 0);
          });
          return fakeChild;
        },
      },
    );
    const result = await resultPromise;
    assert.ok(spawned);
    assert.equal(spawned.command, shellCommandForPlatform());
    assert.equal(spawned.options.cwd, home);
    assert.match(spawned.options.env?.PATH ?? '', /\/bin/);
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /does not exist/);
    assert.match(result.stdout, /ok/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('executeShellTask runs a real shell when cwd is valid', async () => {
  const dir = join(tmpdir(), `jian-shell-ok-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marker.txt'), 'hi\n');
  try {
    const result = await executeShellTask({
      id: 'task-2',
      command: 'cat marker.txt',
      cwd: dir,
      kind: 'shell',
      timeoutMs: 10_000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /hi/);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeShellTask recovers when agent cwd is missing (real spawn)', async () => {
  const result = await executeShellTask({
    id: 'task-3',
    kind: 'shell',
    command: 'echo recovered',
    cwd: join(tmpdir(), `jian-missing-cwd-${process.pid}-${Date.now()}`),
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /recovered/);
  assert.match(result.stderr, /does not exist/);
});

test('a secret environment reaches the command alone, never the log or what is sent back', async () => {
  const secret = 'synthetic-secret-token-0123456789';
  const task = {
    id: 'task-4',
    kind: 'shell' as const,
    command:
      'printf "%s" "$JIAN_SYNTHETIC_SECRET" && printf "%s" "$JIAN_SYNTHETIC_SECRET" >&2 && test -n "$JIAN_SYNTHETIC_SECRET"',
    cwd: null,
    timeoutMs: 10_000,
    env: { JIAN_SYNTHETIC_SECRET: secret },
  };

  const result = await executeShellTask(task);

  // The command saw it (its test passed), and both streams came back masked.
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, '[secret]');
  assert.equal(result.stderr, '[secret]');
  assert.doesNotMatch(JSON.stringify(describeTask(task)), /synthetic-secret-token/);
  assert.equal(process.env.JIAN_SYNTHETIC_SECRET, undefined);
});

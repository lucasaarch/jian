import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createWorkerState,
  describeTask,
  formatLogLine,
  logLineLevel,
  since,
} from '../bin/jian-remote.mjs';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'jian-remote.mjs');

/** The CLI run against a home of its own, holding what the files say. */
function cli(argv, files = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jian-remote-home-'));
  const dir = join(home, '.config', 'jian-remote');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const result = spawnSync(process.execPath, [scriptPath, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
  });
  rmSync(home, { recursive: true, force: true });
  return result;
}

test('a log line carries the time, the level, what happened and its facts', () => {
  const line = formatLogLine(
    'warn',
    'Task finished',
    { task: 'a1', ok: false, error: 'exit 2: not found', empty: '', none: undefined },
    new Date('2026-10-30T12:00:00.000Z'),
  );
  assert.equal(
    line,
    '2026-10-30T12:00:00.000Z WARN  Task finished task=a1 ok=false error="exit 2: not found"\n',
  );
  assert.equal(logLineLevel(line), 'warn');
  assert.equal(logLineLevel('Error: crashed outside the log format'), undefined);
});

test('an action is logged by what it does, never by what was typed', () => {
  assert.deepEqual(
    describeTask({
      id: 't',
      kind: 'computer',
      computer: { action: 'type', text: 'hunter2-secret' },
    }),
    { kind: 'computer', action: 'type', chars: 14 },
  );
  assert.deepEqual(
    describeTask({ id: 't', kind: 'shell', command: 'pnpm   test\n  --run', cwd: '/srv/app' }),
    { kind: 'shell', command: 'pnpm test --run', cwd: '/srv/app' },
  );
});

test('the running worker keeps its connection and what it ran where status reads them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jian-remote-state-'));
  const path = join(dir, 'state.json');
  const worker = createWorkerState({ path });
  const read = () => JSON.parse(readFileSync(path, 'utf8'));

  worker.contact();
  assert.equal(read().connected, true);
  worker.ran('shell', true, 120);
  worker.ran('computer', false, 40);
  assert.deepEqual(read().tasks, { total: 2, failed: 1, shell: 1, computer: 1 });
  assert.deepEqual(
    { kind: read().lastTask.kind, ok: read().lastTask.ok },
    { kind: 'computer', ok: false },
  );
  worker.lost('poll failed: HTTP 503');
  assert.equal(read().connected, false);
  assert.equal(read().lastError, 'poll failed: HTTP 503');
  rmSync(dir, { recursive: true, force: true });
});

test('logs shows the last lines, from the level asked for up', () => {
  const lines = [
    '2026-10-30T12:00:00.000Z INFO  Worker starting version=1.0.6',
    '2026-10-30T12:00:01.000Z DEBUG Poll',
    '2026-10-30T12:00:02.000Z WARN  Task finished ok=false',
    'Error: a crash the service caught',
    '2026-10-30T12:00:03.000Z ERROR Poll failed error="HTTP 503"',
  ].join('\n');

  const warn = cli(['logs', '--level', 'warn'], { 'worker.log': `${lines}\n` });
  assert.equal(warn.status, 0);
  assert.equal(
    warn.stdout,
    [
      '2026-10-30T12:00:02.000Z WARN  Task finished ok=false',
      'Error: a crash the service caught',
      '2026-10-30T12:00:03.000Z ERROR Poll failed error="HTTP 503"',
      '',
    ].join('\n'),
  );
  const last = cli(['logs', '--lines', '1'], { 'worker.log': `${lines}\n` });
  assert.equal(last.stdout, '2026-10-30T12:00:03.000Z ERROR Poll failed error="HTTP 503"\n');
  assert.notEqual(cli(['logs', '--level', 'loud']).status, 0);
});

test('status reports the machine, versions, actions and the gateway it cannot reach', () => {
  const machine = '9f0c2b8e-4a1d-4c6b-9e2f-1a2b3c4d5e6f';
  const config = JSON.stringify({
    // A port nothing listens on: the ping fails at once and says so.
    gateway: 'https://127.0.0.1:9',
    machineId: machine,
    token: 'synthetic-worker-token-that-is-long-enough-1234',
  });
  const state = JSON.stringify({
    pid: 999_999_999,
    connected: true,
    gatewayVersion: '1.0.6',
    capabilities: ['computer-macos'],
    tasks: { total: 3, failed: 1, shell: 2, computer: 1 },
  });
  const result = cli(['status', '--json'], { 'config.json': config, 'state.json': state });
  const report = JSON.parse(result.stdout);

  assert.equal(report.installed, true);
  // The worker that wrote the state is gone: not running, so not connected either.
  assert.equal(report.running, false);
  assert.equal(report.connected, false);
  assert.equal(report.machineId, machine);
  assert.equal(report.ping.ok, false);
  assert.deepEqual(report.tasks, { total: 3, failed: 1, shell: 2, computer: 1 });
  assert.doesNotMatch(result.stdout, /synthetic-worker-token/);

  const text = cli(['status'], { 'config.json': config, 'state.json': state });
  assert.match(text.stdout, /Stopped/);
  assert.match(text.stdout, /3 run \(2 shell, 1 computer\), 1 failed/);
  assert.equal(text.status, 1);
});

test('time since reads as people say it', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  assert.equal(since('2026-10-30T11:59:18Z', now), '42s');
  assert.equal(since('2026-10-30T11:56:48Z', now), '3m 12s');
  assert.equal(since('2026-10-28T08:00:00Z', now), '2d 4h');
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isPidAlive,
  isStaleInstalledWorker,
  parseCliInvocation,
  readWorkerLockPid,
  serviceKindForPlatform,
  shellCommandForPlatform,
} from '../bin/jian-remote.mjs';

const scriptPath = fileURLToPath(new URL('../bin/jian-remote.mjs', import.meta.url));

test('parseCliInvocation treats version flags and the version subcommand', () => {
  assert.deepEqual(parseCliInvocation(['version']), {
    command: 'version',
    versionRequested: true,
  });
  assert.deepEqual(parseCliInvocation(['--version']), {
    command: 'version',
    versionRequested: true,
  });
  assert.deepEqual(parseCliInvocation(['-V']), { command: 'version', versionRequested: true });
  assert.deepEqual(parseCliInvocation(['--version', 'update']), {
    command: 'version',
    versionRequested: true,
  });
  assert.deepEqual(parseCliInvocation(['stop']), { command: 'stop', versionRequested: false });
  assert.deepEqual(parseCliInvocation(['start']), { command: 'start', versionRequested: false });
  assert.deepEqual(parseCliInvocation(['restart']), {
    command: 'restart',
    versionRequested: false,
  });
  assert.deepEqual(parseCliInvocation([]), { command: undefined, versionRequested: false });
});

test('jian-remote --version / -V / version print PACKAGE_VERSION and exit 0', () => {
  for (const argv of [['--version'], ['-V'], ['version']]) {
    const result = spawnSync(process.execPath, [scriptPath, ...argv], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^(0\.0\.0-dev|\d+\.\d+\.\d+)/);
    assert.equal(result.stderr, '');
  }
});

test('help text documents version and stop/start/restart', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /version \| --version \| -V/);
  assert.match(result.stdout, /stop \| start \| restart/);
  assert.match(result.stdout, /jian-remote stop \| start \| restart/);
});

test('isStaleInstalledWorker detects a surviving process after disk was updated', () => {
  const disk = "export const PACKAGE_VERSION = '0.8.2'\n";
  assert.equal(isStaleInstalledWorker('0.8.1', disk), true);
  assert.equal(isStaleInstalledWorker('0.8.2', disk), false);
  assert.equal(isStaleInstalledWorker('0.0.0-dev', disk), false);
  assert.equal(isStaleInstalledWorker('0.8.1', ''), false);
});

test('isPidAlive is true for this process and false for a dead pid', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(2_147_483_646), false);
});

test('readWorkerLockPid reads a pid file and ignores junk', () => {
  const dir = join(tmpdir(), `jian-lock-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, 'worker.pid');
  writeFileSync(lockPath, `${process.pid}\n`);
  assert.equal(readWorkerLockPid(lockPath), process.pid);
  writeFileSync(lockPath, 'not-a-pid\n');
  assert.equal(readWorkerLockPid(lockPath), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('serviceKindForPlatform names the OS service', () => {
  assert.equal(serviceKindForPlatform('darwin'), 'LaunchAgent');
  assert.equal(serviceKindForPlatform('linux'), 'systemd --user');
  assert.equal(serviceKindForPlatform('win32'), 'Task Scheduler');
  assert.equal(serviceKindForPlatform('freebsd'), 'none');
});

test('shellCommandForPlatform prefers an absolute Unix shell', () => {
  assert.equal(shellCommandForPlatform('win32'), 'powershell.exe');
  assert.match(shellCommandForPlatform('linux'), /^\/bin\/(sh|bash)$/);
  assert.match(shellCommandForPlatform('darwin'), /^\/bin\/(sh|bash)$/);
});

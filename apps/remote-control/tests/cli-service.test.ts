import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { shellCommandForPlatform } from '@jian/remote-core';
import { parseCliInvocation } from '../src/args.ts';
import {
  buildLinuxServiceUnit,
  canInstallLinuxSystemUnit,
  chooseLinuxServiceScope,
  linuxServiceKind,
  linuxUserBusAvailable,
} from '../src/linux-service.ts';
import { isPidAlive, readWorkerLockPid } from '../src/lock.ts';
import { serviceKindForPlatform } from '../src/service.ts';
import { isStaleInstalledWorker } from '../src/worker-script.ts';

const scriptPath = fileURLToPath(new URL('../dist/jian-remote.mjs', import.meta.url));

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
  assert.match(result.stdout, /^ {2}version$/m);
  assert.match(result.stdout, /stop \| start \| restart/);
  assert.match(result.stdout, /install \[--system\]/);
  assert.match(result.stdout, /enable-linger|--system/);
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
  assert.equal(serviceKindForPlatform('linux', 'system'), 'systemd (system)');
  assert.equal(serviceKindForPlatform('win32'), 'Task Scheduler');
  assert.equal(serviceKindForPlatform('freebsd'), 'none');
  assert.equal(linuxServiceKind('user'), 'systemd --user');
  assert.equal(linuxServiceKind('system'), 'systemd (system)');
});

test('linuxUserBusAvailable requires XDG_RUNTIME_DIR and a working user bus', () => {
  assert.equal(linuxUserBusAvailable({ env: {}, run: () => ({ status: 0, stderr: '' }) }), false);
  assert.equal(
    linuxUserBusAvailable({
      env: { XDG_RUNTIME_DIR: '/tmp' },
      run: () => ({
        status: 1,
        stderr: 'Failed to connect to bus: No medium found\n',
        stdout: '',
      }),
    }),
    false,
  );
  assert.equal(
    linuxUserBusAvailable({
      env: { XDG_RUNTIME_DIR: '/tmp' },
      run: () => ({ status: 0, stderr: '', stdout: 'HOME=/tmp\n' }),
    }),
    true,
  );
});

test('chooseLinuxServiceScope prefers user, falls back to system, or explains', () => {
  assert.equal(
    chooseLinuxServiceScope({
      userBusAvailable: () => true,
      canSystem: () => true,
    }),
    'user',
  );
  assert.equal(
    chooseLinuxServiceScope({
      preferSystem: true,
      userBusAvailable: () => true,
      canSystem: () => true,
    }),
    'system',
  );
  assert.equal(
    chooseLinuxServiceScope({
      userBusAvailable: () => false,
      canSystem: () => true,
    }),
    'system',
  );
  assert.throws(
    () =>
      chooseLinuxServiceScope({
        preferSystem: true,
        userBusAvailable: () => false,
        canSystem: () => false,
      }),
    /install --system needs write access/,
  );
  assert.throws(
    () =>
      chooseLinuxServiceScope({
        userBusAvailable: () => false,
        canSystem: () => false,
      }),
    /No medium found|enable-linger|install --system|jian-remote\.mjs run/s,
  );
});

test('canInstallLinuxSystemUnit is true for root or a writable system dir', () => {
  assert.equal(canInstallLinuxSystemUnit({ uid: 0, access: () => undefined }), true);
  assert.equal(
    canInstallLinuxSystemUnit({
      uid: 1000,
      access: () => {
        throw new Error('EACCES');
      },
    }),
    false,
  );
  assert.equal(canInstallLinuxSystemUnit({ uid: 1000, access: () => undefined }), true);
});

test('buildLinuxServiceUnit targets default.target for user and multi-user for system', () => {
  const userUnit = buildLinuxServiceUnit({
    script: '/home/ada/.config/jian-remote/jian-remote.mjs',
    scope: 'user',
    home: '/home/ada',
    nodePath: '/usr/bin/node',
    uid: 1000,
  });
  assert.match(userUnit, /WantedBy=default\.target/);
  assert.match(
    userUnit,
    /ExecStart="\/usr\/bin\/node" "\/home\/ada\/\.config\/jian-remote\/jian-remote\.mjs" run/,
  );
  assert.doesNotMatch(userUnit, /^User=/m);

  const systemUnit = buildLinuxServiceUnit({
    script: '/root/.config/jian-remote/jian-remote.mjs',
    scope: 'system',
    home: '/root',
    nodePath: '/usr/bin/node',
    uid: 0,
  });
  assert.match(systemUnit, /WantedBy=multi-user\.target/);
  assert.match(systemUnit, /Environment="HOME=\/root"/);
  assert.doesNotMatch(systemUnit, /^User=/m);

  const systemAsUser = buildLinuxServiceUnit({
    script: '/home/ada/.config/jian-remote/jian-remote.mjs',
    scope: 'system',
    home: '/home/ada',
    nodePath: '/usr/bin/node',
    uid: 1000,
    username: 'ada',
  });
  assert.match(systemAsUser, /^User=ada$/m);
});

test('shellCommandForPlatform prefers an absolute Unix shell', () => {
  assert.equal(shellCommandForPlatform('win32'), 'powershell.exe');
  assert.match(shellCommandForPlatform('linux'), /^\/bin\/(sh|bash)$/);
  assert.match(shellCommandForPlatform('darwin'), /^\/bin\/(sh|bash)$/);
});

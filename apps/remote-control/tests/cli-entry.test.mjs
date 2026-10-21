import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCliEntry } from '../bin/jian-remote.mjs';

const scriptPath = fileURLToPath(new URL('../bin/jian-remote.mjs', import.meta.url));

test('isCliEntry is true for the real script path and for an npm-style .bin symlink', () => {
  const dir = join(tmpdir(), `jian-cli-entry-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const link = join(dir, 'jian-remote');
  symlinkSync(scriptPath, link);

  const meta = pathToFileURL(realpathSync(scriptPath)).href;
  assert.equal(isCliEntry(scriptPath, meta), true);
  assert.equal(isCliEntry(link, meta), true);
  assert.equal(isCliEntry(undefined, meta), false);
  assert.equal(isCliEntry(join(dir, 'missing'), meta), false);

  rmSync(dir, { recursive: true, force: true });
});

test('npx-style symlink invocation prints usage instead of exiting silently', () => {
  const dir = join(tmpdir(), `jian-cli-bin-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const link = join(dir, 'jian-remote');
  symlinkSync(scriptPath, link);

  const result = spawnSync(process.execPath, [link], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Jian Remote worker/);
  assert.match(result.stdout, /install --gateway/);
  assert.equal(result.stderr, '');

  rmSync(dir, { recursive: true, force: true });
});

test('install with bad arguments prints a usage error and exits non-zero', () => {
  const result = spawnSync(
    process.execPath,
    [scriptPath, 'install', '--gateway', 'http://insecure'],
    {
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: jian-remote install/);
});

test('configure without flags prints usage and exits non-zero', () => {
  const result = spawnSync(process.execPath, [scriptPath, 'configure'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: jian-remote configure/);
});

test('help text documents configure alongside install and update', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /configure \[--gateway/);
  assert.match(result.stdout, /install --gateway/);
  assert.match(result.stdout, /update \[--version/);
  assert.match(result.stdout, /stop \| start \| restart/);
  assert.match(result.stdout, /version \| --version \| -V/);
});

test('importing the module for tests does not run the CLI', () => {
  // This file already imported helpers from the bin; surviving to this assertion means the
  // CLI block did not treat the test runner as the entry script.
  assert.equal(dirname(fileURLToPath(import.meta.url)).endsWith('tests'), true);
});

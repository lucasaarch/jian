import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nextUpdateBackoffMs, shouldMatchGatewayVersion } from '@jian/remote-core';
import { isStaleInstalledWorker, validateWorkerScriptBytes } from '../src/worker-script.ts';

const scriptPath = fileURLToPath(new URL('../dist/jian-remote.mjs', import.meta.url));
const realScript = readFileSync(scriptPath);

test('shouldMatchGatewayVersion is false when the gateway has no release', () => {
  assert.equal(shouldMatchGatewayVersion('0.8.1', undefined), false);
  assert.equal(shouldMatchGatewayVersion('0.8.1', '0.0.0-dev'), false);
});

test('shouldMatchGatewayVersion matches patch and major.minor skew to the gateway', () => {
  assert.equal(shouldMatchGatewayVersion('0.8.1', '0.8.2'), true);
  assert.equal(shouldMatchGatewayVersion('0.8.2', '0.8.2'), false);
  assert.equal(shouldMatchGatewayVersion('0.7.9', '0.8.2'), true);
  assert.equal(shouldMatchGatewayVersion('0.9.0', '0.8.2'), true);
  assert.equal(shouldMatchGatewayVersion('0.0.0-dev', '0.8.2'), true);
});

test('nextUpdateBackoffMs grows then caps at 30 minutes', () => {
  assert.equal(nextUpdateBackoffMs(0), 5_000);
  assert.equal(nextUpdateBackoffMs(1), 10_000);
  assert.equal(nextUpdateBackoffMs(2), 20_000);
  assert.equal(nextUpdateBackoffMs(8), 1_280_000);
  assert.equal(nextUpdateBackoffMs(9), 30 * 60_000);
  assert.equal(nextUpdateBackoffMs(99), 30 * 60_000);
});

test('validateWorkerScriptBytes accepts the real worker and rejects junk', () => {
  const ok = validateWorkerScriptBytes(realScript);
  assert.equal(ok.ok, true);
  assert.match(ok.version, /./);

  assert.equal(validateWorkerScriptBytes(Buffer.alloc(0)).ok, false);
  assert.equal(validateWorkerScriptBytes(Buffer.from('<html>not a worker</html>')).ok, false);
  assert.equal(
    validateWorkerScriptBytes(Buffer.from("export const PACKAGE_VERSION = '1.0.0'\n")).ok,
    false,
  );
});

test('isStaleInstalledWorker is true only when disk release differs from this process', () => {
  assert.equal(isStaleInstalledWorker('0.8.1', "export const PACKAGE_VERSION = '0.8.2';\n"), true);
  assert.equal(isStaleInstalledWorker('0.8.2', "export const PACKAGE_VERSION = '0.8.2';\n"), false);
});

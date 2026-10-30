import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { helperPaths } from '../src/computer/macos/helper.ts';
import {
  compatibilityError,
  createLogger,
  createWorkerState,
  hostWording,
  runWorker,
  setHelpersInstallDir,
  setHostWording,
} from '../src/index.ts';

const machineId = '0b6f6a1e-3f0e-4c55-8a7e-2d9f4c1b7a21';
const dir = mkdtempSync(join(tmpdir(), 'jian-worker-host-'));
const cli = hostWording();
after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => setHostWording(cli));

/** A gateway that refuses every poll's token, counting the polls that reach it. */
async function refusingGateway() {
  let polls = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/health') return response.end(JSON.stringify({ version: '1.2.0' }));
    polls += 1;
    response.statusCode = 401;
    response.end(JSON.stringify({ error: 'Unauthorized' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, polls: () => polls, close: () => server.close() };
}

const worker = (base: string, name: string, extra: Partial<Parameters<typeof runWorker>[0]>) =>
  runWorker({
    config: { gateway: base, machineId, token: 'synthetic-worker-token' },
    version: '1.2.0',
    system: 'macOS 27.2',
    log: createLogger({ path: join(dir, `${name}.log`), echo: false }),
    state: createWorkerState({ path: join(dir, `${name}.json`), version: '1.2.0' }),
    capabilities: [],
    ...extra,
  });

test('a refused token stops the worker and tells the host, which can register again', async () => {
  const gateway = await refusingGateway();
  let told = 0;

  await worker(gateway.base, 'refused', { onUnauthorized: () => (told += 1) });

  assert.equal(told, 1);
  assert.equal(gateway.polls(), 1);
  gateway.close();
});

test('without the host listening, a refused token is retried as before', async () => {
  const gateway = await refusingGateway();

  await worker(gateway.base, 'retried', { signal: AbortSignal.timeout(2_500) });

  assert.ok(gateway.polls() >= 2);
  gateway.close();
});

test('a host keeps its own copy of the helper, apart from the CLI', () => {
  const home = join(dir, 'home');
  const cliCopy = helperPaths(home).binary;
  setHelpersInstallDir(join(dir, 'app', 'computer-helper'));

  assert.equal(helperPaths(home).binary, join(dir, 'app', 'computer-helper', 'computer-helper'));
  assert.notEqual(helperPaths(home).binary, cliCopy);
});

test('what the owner is told names the host and how it updates', () => {
  assert.match(
    compatibilityError('1.1.0', '1.2.0') ?? '',
    /Jian Remote 1\.1\.0.*jian-remote update/,
  );

  setHostWording({ name: 'Jian', update: () => 'update the Jian app.', restart: 'Reopen Jian' });

  const message = compatibilityError('1.1.0', '1.2.0') ?? '';
  assert.match(message, /This Jian 1\.1\.0 is incompatible/);
  assert.match(message, /update the Jian app\./);
  assert.doesNotMatch(message, /jian-remote/);
});

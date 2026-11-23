import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUpdater, withVersion } from './updater.mjs';

const token = 'synthetic-updater-token-0123456789abcdef';

async function start() {
  const dir = await mkdtemp(join(tmpdir(), 'jian-updater-'));
  const envFile = join(dir, '.env');
  await writeFile(envFile, 'JIAN_API_TOKEN=synthetic\nJIAN_VERSION=1.0.0\n');
  const runs = [];
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const server = createUpdater({
    token,
    envFile,
    log: () => {},
    run: async (args, env) => {
      runs.push({ args, version: env.JIAN_VERSION });
      if (args[1] === 'up') finish();
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, auth = `Bearer ${token}`) =>
    fetch(`${url}/update`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { server, envFile, runs, done, post };
}

test('pulls and recreates only the gateway and web, by the exact tag, and keeps it in .env', async () => {
  const { server, envFile, runs, done, post } = await start();
  try {
    const response = await post({ version: '1.13.0' });
    assert.equal(response.status, 202);
    await done;
    assert.deepEqual(runs, [
      { args: ['compose', 'pull', 'gateway', 'web'], version: '1.13.0' },
      { args: ['compose', 'up', '-d', '--no-deps', 'gateway', 'web'], version: '1.13.0' },
    ]);
    assert.equal(
      await readFile(envFile, 'utf8'),
      'JIAN_API_TOKEN=synthetic\nJIAN_VERSION=1.13.0\n',
    );
  } finally {
    server.close();
  }
});

test('refuses a wrong or missing token and a version that is not a release', async () => {
  const { server, runs, post } = await start();
  try {
    assert.equal((await post({ version: '1.13.0' }, 'Bearer wrong')).status, 401);
    assert.equal((await post({ version: '1.13.0' }, '')).status, 401);
    assert.equal((await post({ version: 'latest; rm -rf /' })).status, 400);
    assert.deepEqual(runs, []);
  } finally {
    server.close();
  }
});

test('will not start without a token', () => {
  assert.throws(() => createUpdater({ token: '', run: async () => {}, envFile: '/x' }));
});

test('adds JIAN_VERSION to an .env that has none', () => {
  assert.equal(withVersion('A=1', '2.0.0'), 'A=1\nJIAN_VERSION=2.0.0\n');
  assert.equal(withVersion('', '2.0.0'), 'JIAN_VERSION=2.0.0\n');
});

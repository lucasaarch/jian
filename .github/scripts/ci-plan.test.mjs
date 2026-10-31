import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { plan } from './ci-plan.mjs';

const selected = (paths) =>
  Object.entries(plan(paths))
    .filter(([, on]) => on)
    .map(([name]) => name)
    .sort();

test('CI and triage changes do not select product builds', () => {
  assert.deepEqual(selected(['.github/workflows/ci.yml', '.github/scripts/ci-plan.mjs']), [
    'quality',
  ]);
  assert.deepEqual(selected(['.github/scripts/issue-run.mjs']), ['quality', 'triage']);
});
test('host-only changes stay scoped and shared UI reaches both hosts', () => {
  assert.deepEqual(selected(['packages/ui/src/kit/dialog.tsx']), ['desktop', 'ui', 'web']);
  assert.deepEqual(selected(['apps/web/app/page.tsx']), ['web']);
  assert.deepEqual(selected(['apps/desktop/src/main/index.ts']), ['desktop']);
});
test('gateway source reaches its embedded consumer but unit fixtures do not rebuild desktop', () => {
  assert.deepEqual(selected(['apps/gateway/src/local.ts']), ['desktop', 'gateway', 'postgres']);
  assert.deepEqual(selected(['apps/gateway/tests/helpers/database.ts']), ['gateway']);
  assert.deepEqual(selected(['apps/gateway/tests/postgres.test.ts']), ['postgres']);
  assert.deepEqual(selected(['apps/gateway/vitest.config.ts']), ['gateway', 'postgres']);
});
test('database schema and migrations always select real PostgreSQL integration', () => {
  for (const path of ['apps/gateway/migrations/0080.sql', 'apps/gateway/src/storage/schema.ts']) {
    assert.ok(plan([path]).postgres, path);
  }
});
test('contracts and SDK changes reach their actual consumers', () => {
  assert.deepEqual(selected(['packages/contracts/src/sessions.ts']), [
    'contracts',
    'desktop',
    'gateway',
    'postgres',
    'quality',
    'remote',
    'ui',
    'web',
  ]);
  assert.deepEqual(selected(['packages/sdk/src/generated.ts']), [
    'contracts',
    'desktop',
    'quality',
    'ui',
    'web',
  ]);
  assert.deepEqual(selected(['packages/remote-core/native/src/lib.rs']), [
    'desktop',
    'remote',
    'rust',
  ]);
});
test('how the image runs its browser is tested in the image', () => {
  for (const path of [
    'apps/gateway/jian-chromium.sh',
    'apps/gateway/test-inspection.mjs',
    'apps/gateway/src/web/browser.ts',
  ])
    assert.equal(plan([path]).imageGateway, true, path);
});

test('each image requires a change to its Dockerfile, including conservative fallback', () => {
  assert.deepEqual(selected(['apps/gateway/Dockerfile']), ['imageGateway']);
  assert.deepEqual(selected(['apps/web/Dockerfile']), ['imageWeb']);
  for (const path of [
    'pnpm-lock.yaml',
    'apps/gateway/src/main.ts',
    'packages/ui/src/index.ts',
    'unknown-file',
  ]) {
    assert.equal(plan([path]).imageGateway, false, path);
    assert.equal(plan([path]).imageWeb, false, path);
  }
  assert.equal(plan([], true).imageGateway, false);
  assert.equal(plan([], true).imageWeb, false);
});
test('display harness changes run its own checks without building an image', () => {
  assert.deepEqual(selected(['apps/gateway/test-display.py']), ['display']);
});
test('shared Node configuration fans out only to Node consumers', () => {
  const result = plan(['pnpm-lock.yaml']);
  for (const area of ['gateway', 'web', 'desktop', 'remote', 'postgres', 'contracts'])
    assert.equal(result[area], true, area);
  assert.equal(result.rust, false);
  assert.deepEqual(selected(['README.md']), []);
});
test('the required check rejects failed detection and any skipped or failed selected gate', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const literal = workflow
    .match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n {10}NODE/)[1]
    .replace(/^ {10}/gm, '');
  const gates = {
    quality: 'quality',
    gateway: 'gateway',
    web: 'web',
    remote: 'remote',
    triage: 'triage',
    desktop: 'desktop',
    rust: 'rust',
    postgres: 'postgres',
    display: 'display',
    'image-gateway': 'imageGateway',
    'image-web': 'imageWeb',
  };
  const jobs = {
    changes: {
      result: 'success',
      outputs: Object.fromEntries(Object.values(gates).map((key) => [key, 'false'])),
    },
    ...Object.fromEntries(Object.keys(gates).map((name) => [name, { result: 'skipped' }])),
  };
  const run = () =>
    spawnSync(process.execPath, ['--input-type=module'], {
      input: literal,
      env: { ...process.env, RESULTS: JSON.stringify(jobs) },
    }).status;
  assert.equal(run(), 0);
  for (const [name, flag] of Object.entries(gates)) {
    jobs.changes.outputs[flag] = 'true';
    for (const result of ['skipped', 'failure', 'cancelled']) {
      jobs[name].result = result;
      assert.notEqual(run(), 0, `${name}: ${result}`);
    }
    jobs[name].result = 'success';
    assert.equal(run(), 0, name);
    jobs.changes.outputs[flag] = 'false';
  }
  jobs.changes.result = 'failure';
  assert.notEqual(run(), 0);
});

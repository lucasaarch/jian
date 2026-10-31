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

test('triage-only publication avoids application builds and native runners', () => {
  assert.deepEqual(
    selected(['.github/scripts/issue-run.mjs', '.github/workflows/issue-triage.yml']),
    ['triage'],
  );
});
test('shared UI reaches both hosts while host-only changes stay scoped', () => {
  assert.deepEqual(selected(['packages/ui/src/kit/dialog.tsx']), ['desktop', 'node', 'panel']);
  assert.deepEqual(selected(['apps/web/app/page.tsx']), ['node', 'panel']);
  assert.deepEqual(selected(['apps/desktop/src/main/index.ts']), ['desktop', 'node']);
});
test('gateway and worker changes reach the embedded gateway and native resources', () => {
  assert.deepEqual(selected(['apps/gateway/src/local.ts']), [
    'desktop',
    'gateway',
    'image',
    'node',
  ]);
  assert.deepEqual(selected(['packages/remote-core/native/src/lib.rs']), [
    'desktop',
    'gateway',
    'image',
    'node',
    'remote',
    'rust',
  ]);
});
test('contracts propagate to every Node consumer and shared configuration selects all checks', () => {
  assert.deepEqual(selected(['packages/contracts/src/sessions.ts']), [
    'desktop',
    'gateway',
    'image',
    'node',
    'panel',
    'remote',
  ]);
  for (const path of [
    'pnpm-lock.yaml',
    'Makefile',
    '.github/workflows/ci.yml',
    '.github/scripts/ci-plan.mjs',
    'unknown-file',
  ]) {
    assert.ok(Object.values(plan([path])).every(Boolean), path);
  }
  assert.ok(Object.values(plan([], true)).every(Boolean));
});
test('ordinary prose changes need no builds, release notes still reach bundled products', () => {
  assert.deepEqual(selected(['README.md']), []);
  assert.deepEqual(selected(['docs/releases/1.2.3.md']), [
    'desktop',
    'gateway',
    'image',
    'node',
    'panel',
  ]);
});

test('the required check rejects failed detection and every skipped or failed selected desktop gate', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  const literal = workflow
    .match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n {10}NODE/)[1]
    .replace(/^ {10}/gm, '');
  const jobs = {
    changes: {
      result: 'success',
      outputs: Object.fromEntries(
        ['node', 'triage', 'desktop', 'rust', 'gateway', 'image'].map((key) => [key, 'false']),
      ),
    },
    ...Object.fromEntries(
      ['node', 'triage', 'desktop', 'rust', 'postgres', 'image'].map((name) => [
        name,
        { result: 'skipped' },
      ]),
    ),
  };
  const run = () =>
    spawnSync(process.execPath, ['--input-type=module'], {
      input: literal,
      env: { ...process.env, RESULTS: JSON.stringify(jobs) },
    }).status;
  assert.equal(run(), 0);
  jobs.changes.outputs.desktop = 'true';
  for (const result of ['skipped', 'failure', 'cancelled']) {
    jobs.desktop.result = result;
    assert.notEqual(run(), 0, result);
  }
  jobs.desktop.result = 'success';
  assert.equal(run(), 0);
  jobs.changes.result = 'failure';
  assert.notEqual(run(), 0);
});

test('display harness changes select image checks without database or desktop builds', () => {
  assert.deepEqual(selected(['apps/gateway/test-display.py']), ['image']);
});

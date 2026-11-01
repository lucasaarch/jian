import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const source = readFileSync(join(root, '.github/workflows/translate.yml'), 'utf8');
const scripts = ['translate-core.mjs', 'translate-run.mjs', 'translate-config.json'];
const digest = (file) =>
  createHash('sha256')
    .update(readFileSync(join(root, '.github/scripts', file)))
    .digest('hex');
const job = (name) => {
  const match = new RegExp(
    `^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[a-z]+:\\n|(?![\\s\\S]))`,
    'm',
  ).exec(source);
  assert.ok(match, `Missing job ${name}`);
  return match[1];
};

test('it runs on an edited Issue and on an opened or edited pull request, and on nothing else', () => {
  assert.match(
    source,
    /^on:\n {2}issues:\n {4}types: \[edited\]\n {2}pull_request_target:\n {4}branches: \[main\]\n {4}types: \[opened, edited\]\n {2}workflow_dispatch:/m,
  );
  assert.doesNotMatch(source, /^ {2}(?:pull_request|issue_comment|push):/m);
  assert.match(source, /dry_run:[\s\S]*?type: boolean\n {8}default: true/);
});

test('the gate admits only people, and an edit only when the title or body changed', () => {
  const gate = /^ {4}if: (.*)$/m.exec(job('collect'))[1];
  assert.match(gate, /github\.repository == 'lucasaarch\/jian'/);
  assert.match(gate, /github\.event\.repository\.private == false/);
  assert.match(gate, /github\.run_attempt == 1/);
  assert.match(
    gate,
    /github\.event\.issue\.user\.type == 'User' && github\.event\.sender\.type == 'User' && \(github\.event\.changes\.title \|\| github\.event\.changes\.body\)/,
  );
  assert.match(
    gate,
    /github\.event\.pull_request\.user\.type == 'User' && github\.event\.sender\.type == 'User' && \(github\.event\.action == 'opened' \|\| github\.event\.changes\.title \|\| github\.event\.changes\.body\)/,
  );
});

test('pull_request_target never touches the pull request code or expands what its author wrote', () => {
  const checkouts = source.match(/actions\/checkout@[^\n]*\n {8}with:\n {10}ref: [^\n]+/g);
  assert.equal(checkouts.length, 2);
  for (const checkout of checkouts)
    assert.match(checkout, /ref: \$\{\{ github\.workflow_sha \}\}$/);
  assert.equal(source.match(/persist-credentials: false/g).length, 2);
  assert.doesNotMatch(
    source,
    /github\.head_ref|github\.sha|pull_request\.head|github\.event\.(?:issue|pull_request)\.(?:title|body)|github\.event\.changes\.[a-z]+\.from/,
  );
  assert.doesNotMatch(source, /actions\/cache|pnpm install|npm (?:ci|install)/);
});

test('each job holds only its own credentials', () => {
  assert.match(source, /^permissions: \{\}$/m);
  const collect = job('collect'),
    infer = job('infer'),
    publish = job('publish');
  assert.match(
    collect,
    /permissions:\n {6}contents: read\n {6}issues: read\n {6}pull-requests: read\n {6}actions: read/,
  );
  assert.doesNotMatch(collect, /secrets\.|write/);
  assert.match(infer, /permissions:\n {6}actions: read\n {6}issues: read\n {6}pull-requests: read/);
  assert.doesNotMatch(infer, /GITHUB_TOKEN:|actions\/checkout|: write/);
  assert.equal(source.match(/secrets\.GEMINI_API_KEY/g).length, 1);
  assert.match(
    publish,
    /permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: write\n {6}actions: read/,
  );
  assert.doesNotMatch(publish, /GEMINI_API_KEY|secrets\./);
});

test('the jobs run in order, and only on what the one before admitted', () => {
  assert.match(
    job('infer'),
    /needs: collect\n {4}if: \$\{\{ needs\.collect\.outputs\.ready == 'true' \}\}/,
  );
  assert.match(
    job('publish'),
    /needs: \[collect, infer\]\n {4}if: \$\{\{ needs\.infer\.outputs\.ready == 'true' \}\}/,
  );
  assert.doesNotMatch(source, /continue-on-error|--location|--retry|curl.*--header/);
  assert.match(source, /cancel-in-progress: false/);
  assert.equal(source.match(/retention-days: 1/g).length, 1);
});

test('the budget counts the step this workflow really has', () => {
  const runner = readFileSync(join(root, '.github/scripts/translate-run.mjs'), 'utf8'),
    name = /const generationStep = '([^']+)'/.exec(runner)[1];
  assert.ok(job('infer').includes(`- name: ${name}\n`));
});

test('every pin matches the scripts it verifies, in every job that runs them', () => {
  for (const file of scripts) {
    const pins = source.match(new RegExp(`^ +[a-f0-9]{64} {2}${file}$`, 'gm'));
    assert.equal(pins.length, 3, file);
    for (const pin of pins)
      assert.equal(pin.trim(), `${digest(file)}  ${file}`, `Stale hash ${file}`);
  }
  assert.ok(job('infer').includes(`for file in ${scripts.join(' ')}; do`));
  // The triage loads the shared module too, so it pins it as well.
  const triage = readFileSync(join(root, '.github/workflows/issue-triage.yml'), 'utf8'),
    pins = triage.match(/^ +[a-f0-9]{64} {2}translate-core\.mjs$/gm);
  assert.equal(pins.length, 3);
  for (const pin of pins)
    assert.equal(pin.trim(), `${digest('translate-core.mjs')}  translate-core.mjs`);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const source = () => readFileSync(join(root, '.github/workflows/issue-triage.yml'), 'utf8');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const jobs = (value) =>
  Object.fromEntries(
    [
      ...value.matchAll(
        /^ {2}(collect|infer|publish):\n([\s\S]*?)(?=^ {2}[a-z]+:\n|$(?![\s\S]))/gm,
      ),
    ].map((m) => [m[1], m[2]]),
  );
function step(job, name) {
  const start = job.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `Missing step ${name}`);
  const end = job.indexOf('\n      - ', start + 1);
  return job.slice(start, end < 0 ? undefined : end);
}
function script(block) {
  const body = block.slice(block.indexOf('        run: |\n') + '        run: |\n'.length);
  assert.ok(block.includes('        run: |\n'));
  return body
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-workflow-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function runShell(body, dir, env = {}) {
  return spawnSync('/bin/bash', ['-c', body], {
    cwd: dir,
    env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'output'), ...env },
    encoding: 'utf8',
  });
}

test('Issue-only trigger, repository queue and immutable provenance are explicit', () => {
  const w = source();
  assert.match(w, /on:\n {2}issues:\n {4}types: \[opened\]\n {2}workflow_dispatch:/);
  assert.doesNotMatch(w, /^ {2}(?:pull_request|issue_comment):|types:.*edited/m);
  assert.match(w, /dry_run:[\s\S]*?type: boolean\n {8}default: true/);
  assert.match(
    w,
    /^permissions: \{\}\nconcurrency:\n {2}group: issue-triage-\$\{\{ github.repository \}\}\n {2}cancel-in-progress: false\n {2}queue: max\n/m,
  );
  assert.match(
    w,
    /run-name:.*issue-triage:\{0\}:dry.*issue-triage:\{0\}:\{1\}:\{2\}:manual.*issue-triage:\{0\}:\{1\}:\{2\}:live/,
  );
  assert.match(w, /SOURCE_SHA: \$\{\{ github.workflow_sha \}\}/);
  assert.doesNotMatch(w, /github\.sha|github\.event\.issue\.(title|body)/);
  const j = jobs(w);
  assert.deepEqual(Object.keys(j), ['collect', 'infer', 'publish']);
  assert.match(j.collect, /github\.event\.repository\.private == false/);
  assert.match(j.collect, /github\.run_attempt == 1/);
  assert.match(
    j.collect,
    /github\.event\.issue\.user\.type == 'User' && github\.event\.sender\.type == 'User'/,
  );
  assert.match(
    j.collect,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
});

test('credential and whole-writer gates preserve persistent skipped generation history', () => {
  const j = jobs(source());
  assert.match(j.collect, /permissions:\n {6}contents: read\n {6}issues: read\n {6}actions: read/);
  assert.match(j.infer, /name: Gemini inference\n {4}if: \$\{\{ always\(\) \}\}/);
  assert.match(j.infer, /permissions:\n {6}actions: read\n {6}issues: read/);
  assert.doesNotMatch(j.infer, /GITHUB_TOKEN:|actions\/checkout/);
  assert.match(j.infer, /token: ''/);
  assert.equal(source().match(/secrets\.GEMINI_API_KEY/g)?.length, 1);
  const gen = step(j.infer, 'Generate Gemini proposal');
  assert.match(gen, /if: \$\{\{ steps.gate.outputs.ready == 'true' \}\}/);
  assert.match(gen, /GEMINI_API_KEY: \$\{\{ secrets.GEMINI_API_KEY \}\}/);
  assert.match(gen, /GITHUB_API_TOKEN/);
  for (const name of ['Bootstrap trusted inference scripts', 'Prepare fresh inference directories'])
    assert.match(step(j.infer, name), /if: \$\{\{ steps.gate.outputs.ready == 'true' \}\}/);
  assert.match(
    j.publish,
    /if:.*needs\.collect\.outputs\.publish_enabled == 'true'.*needs\.infer\.outputs\.ready == 'true'.*github\.event_name == 'issues'/,
  );
  assert.match(j.publish, /permissions:\n {6}contents: read\n {6}issues: write\n {6}actions: read/);
  assert.doesNotMatch(j.publish, /GEMINI_API_KEY|secrets\./);
  assert.match(
    j.infer,
    /infer "\$RUNNER_TEMP\/issue-context.json" "\$RUNNER_TEMP\/issue-snapshot" "\$RUNNER_TEMP\/issue-proposal\/artifact.json"/,
  );
  assert.match(
    j.publish,
    /publish "\$RUNNER_TEMP\/issue-context.json" "\$RUNNER_TEMP\/issue-proposal"/,
  );
  assert.equal(source().match(/retention-days: 1/g)?.length, 2);
  assert.doesNotMatch(
    source(),
    /retention-days: (?:[2-9]|\d\d)|continue-on-error|--location|--retry|curl.*--header/,
  );
});

test('literal inference gate refuses blocked, dry, disabled, failed or inherited GitHub credentials', () =>
  fixture((dir) => {
    const gate = script(step(jobs(source()).infer, 'Decide inference readiness'));
    const good = {
      COLLECT_RESULT: 'success',
      COLLECT_READY: 'true',
      LIVE_ENABLED: 'true',
      DRY_RUN: 'false',
    };
    for (const [change, expected] of [
      [{}, 'true'],
      [{ COLLECT_RESULT: 'failure' }, 'false'],
      [{ COLLECT_READY: 'false' }, 'false'],
      [{ LIVE_ENABLED: 'false' }, 'false'],
      [{ DRY_RUN: 'true' }, 'false'],
      [{ DRY_RUN: 'unknown' }, 'false'],
      [{ GITHUB_TOKEN: '' }, 'false'],
    ]) {
      rmSync(join(dir, 'output'), { force: true });
      const result = runShell(gate, dir, { ...good, ...change });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(dir, 'output'), 'utf8').trim(), `ready=${expected}`);
    }
  }));

test('literal anonymous bootstrap verifies all three pinned hashes before importing any code', () =>
  fixture((dir) => {
    const body = script(step(jobs(source()).infer, 'Bootstrap trusted inference scripts'));
    const files = ['issue-core.mjs', 'issue-run.mjs', 'issue-config.json'];
    for (const file of files)
      assert.ok(
        body.includes(`${digest(readFileSync(join(root, '.github/scripts', file)))}  ${file}`),
        `Stale hash ${file}`,
      );
    const bin = join(dir, 'bin'),
      fixtures = join(dir, 'fixtures');
    mkdirSync(bin);
    mkdirSync(fixtures);
    for (const file of files)
      copyFileSync(join(root, '.github/scripts', file), join(fixtures, file));
    writeFileSync(
      join(bin, 'curl'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture is a literal shell script.
      '#!/bin/bash\nset -eu\nurl=""; output=""\nwhile [ "$#" -gt 0 ]; do\n case "$1" in https://*) url="$1";; --output) shift; output="$1";; --header|-H|-L|--location) exit 90;; esac\n shift\ndone\n[[ "$url" =~ ^https://raw.githubusercontent.com/lucasaarch/jian/[a-f0-9]{40}/.github/scripts/(issue-core.mjs|issue-run.mjs|issue-config.json)$ ]]\ncp "$FIXTURES/${url##*/}" "$output"\nprintf "%s\\n" "$url" >> "$CURL_LOG"\n',
      { mode: 0o700 },
    );
    writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexec /usr/bin/shasum -a 256 "$@"\n', {
      mode: 0o700,
    });
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      FIXTURES: fixtures,
      CURL_LOG: join(dir, 'curl-log'),
      SOURCE_SHA: 'a'.repeat(40),
      ISSUE_REPOSITORY: 'lucasaarch/jian',
    };
    const good = runShell(body, dir, env);
    assert.equal(good.status, 0, good.stderr);
    assert.match(readFileSync(join(dir, 'output'), 'utf8'), /enabled=true\npublish_enabled=true/);
    assert.equal(readFileSync(join(dir, 'curl-log'), 'utf8').trim().split('\n').length, 3);
    for (const file of files) {
      rmSync(join(dir, 'issue-source'), { recursive: true, force: true });
      rmSync(join(dir, 'output'), { force: true });
      const bad = runShell(
        body.replace(
          `${digest(readFileSync(join(root, '.github/scripts', file)))}  ${file}`,
          `${'0'.repeat(64)}  ${file}`,
        ),
        dir,
        env,
      );
      assert.notEqual(bad.status, 0);
      assert.equal(bad.stdout, '');
      assert.throws(() => readFileSync(join(dir, 'output')));
    }
    // A module with a visible import side effect still cannot run when a later file fails verification.
    const sentinel = join(dir, 'imported');
    const core = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'imported'); export const config = {};\n`;
    writeFileSync(join(fixtures, 'issue-core.mjs'), core);
    rmSync(join(dir, 'issue-source'), { recursive: true, force: true });
    const lateFailure = body
      .replace(/^[a-f0-9]{64} {2}issue-core.mjs$/m, `${digest(core)}  issue-core.mjs`)
      .replace(/^[a-f0-9]{64} {2}issue-config.json$/m, `${'0'.repeat(64)}  issue-config.json`);
    assert.notEqual(runShell(lateFailure, dir, env).status, 0);
    assert.throws(() => readFileSync(sentinel));
  }));

test('fresh transfer directories refuse reuse and CLI retains exact guarded source contracts', () =>
  fixture((dir) => {
    const prepare = script(step(jobs(source()).infer, 'Prepare fresh inference directories'));
    assert.equal(runShell(prepare, dir, { ISSUE_CONTEXT: JSON.stringify({}) }).status, 0);
    assert.equal(statSync(join(dir, 'issue-context.json')).mode & 0o777, 0o600);
    assert.notEqual(runShell(prepare, dir, { ISSUE_CONTEXT: '{}' }).status, 0);
    const runner = readFileSync(join(root, '.github/scripts/issue-run.mjs'), 'utf8');
    assert.match(
      runner,
      /entries\.length\s*!==\s*1\s*\|\|\s*entries\[0\]\s*!==\s*["']artifact\.json["']/,
    );
    assert.match(runner, /isSymbolicLink\(\)[\s\S]*?nlink\s*!==\s*1/);
    assert.match(runner, /Object\.hasOwn\(env,\s*["']GITHUB_TOKEN["']\)/);
    assert.match(runner, /Object\.hasOwn\(env,\s*["']GEMINI_API_KEY["']\)/);
  }));

test('literal opened context stores only eleven trusted metadata keys and rejects invalid mode/origin', () =>
  fixture((dir) => {
    const build = script(step(jobs(source()).collect, 'Build trusted Issue context'));
    const eventPath = join(dir, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({
        action: 'opened',
        repository: { full_name: 'lucasaarch/jian', private: false },
        issue: {
          number: 21,
          id: 321,
          title: 'do not persist',
          body: 'do not persist',
          state: 'open',
        },
      }),
    );
    const env = {
      GITHUB_EVENT_PATH: eventPath,
      ISSUE_REPOSITORY: 'lucasaarch/jian',
      ISSUE_EVENT: 'issues',
      ISSUE_REF: 'refs/heads/main',
      ISSUE_DEFAULT_BRANCH: 'main',
      SOURCE_SHA: 'a'.repeat(40),
      ISSUE_RUN_ID: '100',
      ISSUE_RUN_ATTEMPT: '1',
      ISSUE_ACTOR: 'maintainer',
      ISSUE_DRY_RUN: 'false',
      ISSUE_NUMBER: '',
    };
    const good = runShell(build, dir, env);
    assert.equal(good.status, 0, good.stderr);
    const context = JSON.parse(readFileSync(join(dir, 'issue-context.json'), 'utf8'));
    assert.deepEqual(Object.keys(context), [
      'repo',
      'issueNumber',
      'issueId',
      'event',
      'ref',
      'defaultBranch',
      'workflowSha',
      'runId',
      'runAttempt',
      'actor',
      'dryRun',
    ]);
    assert.equal(context.issueId, 321);
    assert.equal(context.event, 'opened');
    assert.equal(context.dryRun, false);
    for (const change of [
      { ISSUE_DRY_RUN: 'true' },
      { ISSUE_EVENT: 'issue_comment' },
      { ISSUE_REF: 'refs/heads/other' },
      { SOURCE_SHA: 'x'.repeat(40) },
      { ISSUE_RUN_ATTEMPT: '2' },
    ]) {
      rmSync(join(dir, 'issue-context.json'), { force: true });
      assert.notEqual(runShell(build, dir, { ...env, ...change }).status, 0);
      assert.throws(() => readFileSync(join(dir, 'issue-context.json')));
    }
  }));

test('old PR automation is removed and CI gate and essential jobs are unchanged', () => {
  for (const path of [
    '.github/workflows/gemini-pilot.yml',
    '.github/pilot.md',
    ...['core.mjs', 'run.mjs', 'config.json'].map((f) => `.github/scripts/pilot-${f}`),
    '.github/scripts/pilot.test.mjs',
  ]) {
    assert.throws(() => readFileSync(join(root, path)));
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.scripts.check.includes('pnpm test:triage'));
  assert.equal(manifest.scripts['test:triage'], 'node --test .github/scripts/issue-*.test.mjs');
});

test('literal manual ID resolution is bounded, read-only and never logs source bodies', () =>
  fixture((dir) => {
    const build = script(step(jobs(source()).collect, 'Build trusted Issue context'));
    const eventPath = join(dir, 'event.json'),
      fakeFetch = join(dir, 'fetch-fixture.mjs'),
      fetchLog = join(dir, 'fetch-log');
    writeFileSync(
      eventPath,
      JSON.stringify({ repository: { full_name: 'lucasaarch/jian', private: false } }),
    );
    writeFileSync(
      fakeFetch,
      `import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs';
    globalThis.fetch = async (url, options) => {
      if(url.includes('/collaborators/') && url.endsWith('/permission')) {
        assert.equal(options.method,'GET');
        const login=url.split('/collaborators/')[1].split('/')[0];
        return Response.json({permission:login==='admin'?'admin':'maintain',user:{login}});
      }
      assert.equal(url,'https://api.github.com/repos/lucasaarch/jian/issues/21');
      assert.equal(options.method,'GET'); assert.equal(options.redirect,'error');
      assert.equal(options.headers.Authorization,'Bearer synthetic-token');
      assert.equal(options.headers['X-GitHub-Api-Version'],'2026-03-10');
      assert.ok(options.signal instanceof AbortSignal);
      writeFileSync(process.env.FETCH_LOG,'read');
      const mode=process.env.FIXTURE_CASE;
      const issue={number:21,id:321,state:'open',url,body:'source-private-marker-never-log'};
      if(mode==='pr')issue.pull_request={}; if(mode==='closed')issue.state='closed';
      if(mode==='moved')issue.url='https://untrusted.invalid/'; if(mode==='oversize')issue.body='x'.repeat(2*1024*1024);
      return new Response(JSON.stringify(issue),{status:mode==='http-failure'?403:200});
    };`,
    );
    const env = {
      NODE_OPTIONS: `--import=${fakeFetch}`,
      FETCH_LOG: fetchLog,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_TOKEN: 'synthetic-token',
      ISSUE_REPOSITORY: 'lucasaarch/jian',
      ISSUE_EVENT: 'workflow_dispatch',
      ISSUE_REF: 'refs/heads/main',
      ISSUE_DEFAULT_BRANCH: 'main',
      SOURCE_SHA: 'a'.repeat(40),
      ISSUE_RUN_ID: '100',
      ISSUE_RUN_ATTEMPT: '1',
      ISSUE_ACTOR: 'maintainer',
      ISSUE_DRY_RUN: 'true',
      ISSUE_NUMBER: '21',
    };
    const result = runShell(build, dir, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    const context = JSON.parse(readFileSync(join(dir, 'issue-context.json'), 'utf8'));
    assert.equal(context.event, 'manualdry');
    assert.equal(context.dryRun, true);
    assert.equal(context.issueId, 321);
    assert.equal(Object.keys(context).length, 11);
    assert.ok(!readFileSync(join(dir, 'issue-context.json'), 'utf8').includes('marker'));
    rmSync(join(dir, 'issue-context.json'), { force: true });
    const live = runShell(build, dir, { ...env, ISSUE_ACTOR: 'admin', ISSUE_DRY_RUN: 'false' });
    assert.equal(live.status, 0, live.stderr);
    const liveContext = JSON.parse(readFileSync(join(dir, 'issue-context.json'), 'utf8'));
    assert.equal(liveContext.event, 'manual');
    assert.equal(liveContext.dryRun, false);
    rmSync(join(dir, 'issue-context.json'), { force: true });
    for (const mode of ['pr', 'closed', 'moved', 'oversize', 'http-failure']) {
      rmSync(join(dir, 'issue-context.json'), { force: true });
      const blocked = runShell(build, dir, { ...env, FIXTURE_CASE: mode });
      assert.notEqual(blocked.status, 0);
      assert.equal(blocked.stdout, 'Context refused.\n');
      assert.equal(blocked.stderr, '');
      assert.throws(() => readFileSync(join(dir, 'issue-context.json')));
    }
    for (const change of [{ ISSUE_NUMBER: '21; touch unsafe' }, { ISSUE_DRY_RUN: 'false' }]) {
      rmSync(fetchLog, { force: true });
      assert.notEqual(runShell(build, dir, { ...env, ...change }).status, 0);
      assert.throws(() => readFileSync(fetchLog));
    }
    writeFileSync(
      eventPath,
      JSON.stringify({ repository: { full_name: 'lucasaarch/jian', private: true } }),
    );
    rmSync(fetchLog, { force: true });
    assert.notEqual(runShell(build, dir, env).status, 0);
    assert.throws(() => readFileSync(fetchLog));
  }));

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { collect, infer, publish, runCLI } from './translate-run.mjs';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const root = 'https://api.github.com/repos/lucasaarch/jian';
const sha = 'a'.repeat(40);

/** A GitHub and a Gemini in memory; every test reads what reached them, never how it got there. */
function world({ kind = 'pull', item: change = {}, event = 'opened', runs = [], jobs = {} } = {}) {
  const item = {
    number: 7,
    id: 70,
    state: 'open',
    title: 'fix(ui): corrige o botão',
    body: '## Resumo\r\n\r\n- [ ] Rodei os testes\r\n\r\nCorrige #12, como @maintainer pediu.',
    user: { login: 'person', type: 'User' },
    ...(kind === 'pull' ? { base: { ref: 'main' } } : {}),
    ...change,
  };
  const state = {
    item,
    writes: [],
    generations: 0,
    counts: 0,
    reads: [],
    permission: 'admin',
    runConclusionPath: '.github/workflows/translate.yml',
    onCount: () => {},
    onGenerate: () => {},
    onRead: () => {},
    finish: 'STOP',
    answer: (prompt) => {
      const { title, body } = JSON.parse(prompt);
      return {
        title: title.replace('corrige o botão', 'fixes the button'),
        body: body
          .replace('Resumo', 'Summary')
          .replace('Rodei os testes', 'I ran the tests')
          .replace('Corrige', 'Fixes')
          .replace(', como', ', as')
          .replace('pediu', 'asked'),
        needsTranslation: true,
      };
    },
  };
  const route = kind === 'pull' ? 'pulls' : 'issues';
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const fetch = async (url, options) => {
    const u = new URL(url),
      path = `${u.origin}${u.pathname}`;
    if (u.hostname === 'generativelanguage.googleapis.com') {
      assert.equal(options.headers['x-goog-api-key'], 'synthetic-key');
      if (path.endsWith(':countTokens')) {
        state.counts++;
        state.onCount();
        return json({ totalTokens: state.tokens ?? 50 });
      }
      state.generations++;
      state.onGenerate();
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      state.prompt = prompt;
      return json({
        candidates: [
          {
            finishReason: state.finish,
            content: { role: 'model', parts: [{ text: JSON.stringify(state.answer(prompt)) }] },
          },
        ],
      });
    }
    if (options.method === 'PATCH') {
      assert.equal(path, `${root}/${route}/7`);
      assert.match(options.headers.Authorization, /^Bearer synthetic-writer$/);
      const body = JSON.parse(options.body);
      state.writes.push(body);
      if (!state.ignoreWrite) Object.assign(state.item, body);
      return state.failWrite ? json({}, 500) : json(state.item);
    }
    state.reads.push(u.pathname);
    state.onRead(u.pathname);
    if (path === root)
      return json({
        full_name: 'lucasaarch/jian',
        private: state.privateRepo === true,
        visibility: state.privateRepo === true ? 'private' : 'public',
        default_branch: 'main',
      });
    if (path === `${root}/${route}/7`) return json(state.item);
    if (path === `${root}/actions/runs/500`)
      return json({
        id: 500,
        path: state.runConclusionPath,
        event: state.eventName ?? (kind === 'pull' ? 'pull_request_target' : 'issues'),
        run_attempt: 1,
        status: 'in_progress',
        actor: { login: 'person' },
        repository: { full_name: 'lucasaarch/jian' },
      });
    if (path === `${root}/actions/workflows/translate.yml/runs`) {
      assert.equal(u.searchParams.get('created'), '>=2026-11-01');
      const page = Number(u.searchParams.get('page')),
        size = Number(u.searchParams.get('per_page'));
      return json({ workflow_runs: runs.slice((page - 1) * size, page * size) });
    }
    const jobsPath = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(path);
    if (jobsPath) return json({ jobs: jobs[`${jobsPath[1]}/${jobsPath[2]}`] ?? [] });
    if (path === `${root}/collaborators/person/permission`)
      return json({ permission: state.permission, user: { login: 'person' } });
    return json({}, 404);
  };
  const transport = { fetch, now: () => NOW, sleep: async () => {} };
  return { state, transport, kind, event };
}

function setup(t, w, change = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'translate-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eventPath = join(dir, 'event.json'),
    item = w.kind === 'pull' ? 'pull_request' : 'issue';
  writeFileSync(eventPath, JSON.stringify({ action: w.event, [item]: { number: 7, id: 70 } }));
  const env = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_TOKEN: 'synthetic-reader',
    TRANSLATE_REPOSITORY: 'lucasaarch/jian',
    TRANSLATE_EVENT_NAME: w.kind === 'pull' ? 'pull_request_target' : 'issues',
    TRANSLATE_REF: 'refs/heads/main',
    TRANSLATE_DEFAULT_BRANCH: 'main',
    TRANSLATE_ACTOR: 'person',
    TRANSLATE_RUN_ID: '500',
    TRANSLATE_RUN_ATTEMPT: '1',
    TRANSLATE_DRY_RUN: 'false',
    SOURCE_SHA: sha,
    ...change,
  };
  return { dir, env };
}

const inferEnv = (context) => ({
  GEMINI_API_KEY: 'synthetic-key',
  GITHUB_API_TOKEN: 'synthetic-reader',
  TRANSLATE_CONTEXT: JSON.stringify(context),
});
const publishEnv = (context) => ({
  GITHUB_TOKEN: 'synthetic-writer',
  TRANSLATE_CONTEXT: JSON.stringify(context),
});

async function pipeline(t, w) {
  const { dir, env } = setup(t, w);
  const collected = await collect(env, w.transport);
  assert.equal(collected.state, 'ready', collected.reason);
  const artifact = join(dir, 'proposal');
  rmSync(artifact, { force: true, recursive: true });
  spawnSync('mkdir', ['-m', '700', artifact]);
  const inferred = await infer(
    inferEnv(collected.context),
    join(artifact, 'artifact.json'),
    w.transport,
  );
  return { collected, inferred, artifact, dir };
}

test('a pull request in Portuguese is written back in English with its Markdown and references', async (t) => {
  const w = world();
  const { collected, inferred, artifact } = await pipeline(t, w);
  assert.equal(inferred.state, 'ready', inferred.reason);
  // Neither what GitHub acts on nor the title's convention was ever shown to the model.
  assert.doesNotMatch(w.state.prompt, /#12|@maintainer|fix\(ui\)/);
  const published = await publish(publishEnv(collected.context), artifact, w.transport);
  assert.equal(published.reason, 'PUBLISHED');
  assert.deepEqual(w.state.writes, [
    {
      title: 'fix(ui): fixes the button',
      body: '## Summary\n\n- [ ] I ran the tests\n\nFixes #12, as @maintainer asked.',
    },
  ]);
});

test('an edited Issue goes through its own route, and no label or comment is touched', async (t) => {
  const w = world({ kind: 'issue', event: 'edited' });
  const { collected, inferred, artifact } = await pipeline(t, w);
  assert.equal(inferred.state, 'ready', inferred.reason);
  assert.equal(
    (await publish(publishEnv(collected.context), artifact, w.transport)).state,
    'ready',
  );
  assert.equal(w.state.writes.length, 1);
  assert.deepEqual(Object.keys(w.state.writes[0]).sort(), ['body', 'title']);
});

test('text already in English costs one answer and writes nothing', async (t) => {
  const w = world({ item: { title: 'fix(ui): the button', body: 'The button fails.' } });
  w.state.answer = (prompt) => ({ ...JSON.parse(prompt), needsTranslation: false });
  const { inferred, artifact } = await pipeline(t, w);
  assert.deepEqual(inferred, { state: 'refused', reason: 'ALREADY_ENGLISH' });
  assert.throws(() => statSync(join(artifact, 'artifact.json')));
  assert.equal(w.state.writes.length, 0);
});

for (const [name, change, expected] of [
  ['an app', { user: { login: 'mia-jian[bot]', type: 'Bot' } }, 'NOT_ELIGIBLE'],
  ['a closed item', { state: 'closed' }, 'NOT_ELIGIBLE'],
  ['another base', { base: { ref: 'release' } }, 'NOT_ELIGIBLE'],
  ['a possible secret', { body: 'A chave é password: hunter2' }, 'UNSAFE_SOURCE'],
  ['text too large', { body: 'a'.repeat(5000) }, 'TOO_LARGE'],
]) {
  test(`${name} is refused quietly before any model call or write`, async (t) => {
    const w = world({ item: change }),
      { env } = setup(t, w),
      result = await collect(env, w.transport);
    assert.deepEqual(result, { state: 'refused', reason: expected });
    assert.equal(w.state.counts + w.state.generations + w.state.writes.length, 0);
  });
}

test('a private repository is refused before any model call or write', async (t) => {
  const w = world();
  w.state.privateRepo = true;
  const { env } = setup(t, w);
  assert.equal((await collect(env, w.transport)).reason, 'NOT_ELIGIBLE');
  assert.equal(w.state.counts + w.state.writes.length, 0);
});

test('a run that is not this workflow fails instead of acting', async (t) => {
  const w = world();
  w.state.runConclusionPath = '.github/workflows/other.yml';
  const { env } = setup(t, w);
  const result = await runCLI(['collect'], env, w.transport);
  assert.deepEqual(result, { state: 'failed', reason: 'RUN_ORIGIN_REFUSED' });
});

test('an unexpected context is refused before any read', async (t) => {
  for (const change of [
    { TRANSLATE_REF: 'refs/heads/other' },
    { TRANSLATE_RUN_ATTEMPT: '2' },
    { SOURCE_SHA: 'x'.repeat(40) },
    { TRANSLATE_REPOSITORY: 'someone/else' },
    { TRANSLATE_EVENT_NAME: 'issue_comment' },
  ]) {
    const w = world(),
      { env } = setup(t, w, change);
    assert.deepEqual(await runCLI(['collect'], env, w.transport), {
      state: 'failed',
      reason: 'CONTEXT_REFUSED',
    });
    assert.equal(w.state.reads.length, 0);
  }
});

test('an opened Issue belongs to the triage, not to this workflow', async (t) => {
  const w = world({ kind: 'issue', event: 'opened' }),
    { env } = setup(t, w);
  assert.equal((await runCLI(['collect'], env, w.transport)).reason, 'CONTEXT_REFUSED');
});

test('an edit during the token count stops the paid call', async (t) => {
  const w = world();
  w.state.onCount = () => {
    w.state.item.body = 'Outro texto.';
  };
  const { inferred } = await pipeline(t, w);
  assert.deepEqual(inferred, { state: 'refused', reason: 'CHANGED' });
  assert.equal(w.state.generations, 0);
});

test('an edit after the translation was made is never overwritten by it', async (t) => {
  const w = world();
  const { collected, inferred, artifact } = await pipeline(t, w);
  assert.equal(inferred.state, 'ready');
  w.state.item.body = 'Agora escrevi outra coisa.';
  const published = await publish(publishEnv(collected.context), artifact, w.transport);
  assert.deepEqual(published, { state: 'refused', reason: 'CHANGED' });
  assert.equal(w.state.writes.length, 0);
  assert.equal(w.state.item.body, 'Agora escrevi outra coisa.');
});

test('a translation that loses a protected token is refused and writes nothing', async (t) => {
  const w = world();
  w.state.answer = () => ({ title: 'Fixed', body: 'Fixed.', needsTranslation: true });
  const { inferred, artifact } = await pipeline(t, w);
  assert.deepEqual(inferred, { state: 'refused', reason: 'INVALID_TRANSLATION' });
  assert.throws(() => statSync(join(artifact, 'artifact.json')));
});

test('a reply cut short is refused and writes nothing', async (t) => {
  const w = world();
  w.state.finish = 'MAX_TOKENS';
  const { inferred } = await pipeline(t, w);
  assert.equal(inferred.reason, 'INVALID_TRANSLATION');
});

test('too many tokens refuse before the paid call', async (t) => {
  const w = world();
  w.state.tokens = 9000;
  const { inferred } = await pipeline(t, w);
  assert.equal(inferred.reason, 'TOO_LARGE');
  assert.equal(w.state.generations, 0);
});

test('a write GitHub does not show afterwards fails loudly', async (t) => {
  for (const mode of ['ignoreWrite', 'failWrite']) {
    const w = world();
    const { collected, artifact } = await pipeline(t, w);
    w.state[mode] = true;
    const result = await runCLI(['publish', artifact], publishEnv(collected.context), w.transport);
    assert.deepEqual(result, { state: 'failed', reason: 'WRITE_UNCONFIRMED' }, mode);
  }
});

test('the key and the write token are never in the same step', async (t) => {
  const w = world();
  const { collected, artifact } = await pipeline(t, w);
  const context = collected.context;
  for (const [command, env] of [
    [['infer', join(artifact, 'other.json')], { ...inferEnv(context), GITHUB_TOKEN: 'x' }],
    [['infer', join(artifact, 'other.json')], { ...inferEnv(context), GEMINI_API_KEY: '' }],
    [['publish', artifact], { ...publishEnv(context), GEMINI_API_KEY: 'x' }],
    [['publish', artifact], { ...publishEnv(context), GITHUB_TOKEN: '' }],
  ]) {
    const before = w.state.generations + w.state.writes.length;
    assert.deepEqual(await runCLI(command, env, w.transport), {
      state: 'failed',
      reason: 'CREDENTIAL_ISOLATION',
    });
    assert.equal(w.state.generations + w.state.writes.length, before);
  }
});

test('an artifact from another item, or with extra files, is refused', async (t) => {
  const w = world();
  const { collected, artifact } = await pipeline(t, w);
  const other = { ...collected.context, contentHash: 'b'.repeat(64) };
  assert.equal(
    (await runCLI(['publish', artifact], publishEnv(other), w.transport)).reason,
    'ARTIFACT_REFUSED',
  );
  writeFileSync(join(artifact, 'extra.json'), '{}');
  assert.equal(
    (await runCLI(['publish', artifact], publishEnv(collected.context), w.transport)).reason,
    'ARTIFACT_REFUSED',
  );
  assert.equal(w.state.writes.length, 0);
});

const step = (started, conclusion = 'success') => ({
  name: 'Generate translation',
  started_at: new Date(started).toISOString(),
  conclusion,
});
test('generations this hour exhaust the budget, quietly', async (t) => {
  const runs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, run_attempt: 1 })),
    jobs = Object.fromEntries(runs.map((run) => [`${run.id}/1`, [{ steps: [step(NOW - 60000)] }]])),
    w = world({ runs, jobs }),
    { env } = setup(t, w);
  assert.deepEqual(await collect(env, w.transport), {
    state: 'refused',
    reason: 'BUDGET_EXHAUSTED',
  });
});

test('generations this month exhaust the budget', async (t) => {
  const runs = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, run_attempt: 1 })),
    jobs = Object.fromEntries(
      runs.map((run) => [`${run.id}/1`, [{ steps: [step(NOW - 86400000)] }]]),
    ),
    w = world({ runs, jobs }),
    { env } = setup(t, w);
  assert.equal((await collect(env, w.transport)).reason, 'BUDGET_EXHAUSTED');
  // Reading all of them proves this was the count, and not a history too long to read.
  assert.equal(w.state.reads.filter((path) => path.endsWith('/jobs')).length, 100);
});

test('one generation under the month limit still fits', async (t) => {
  const runs = Array.from({ length: 99 }, (_, i) => ({ id: i + 1, run_attempt: 1 })),
    jobs = Object.fromEntries(
      runs.map((run) => [`${run.id}/1`, [{ steps: [step(NOW - 86400000)] }]]),
    ),
    w = world({ runs, jobs }),
    { env } = setup(t, w);
  assert.equal((await collect(env, w.transport)).state, 'ready');
});

test('a month too long to read refuses instead of spending blindly', async (t) => {
  const runs = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      run_attempt: 1,
      conclusion: 'skipped',
    })),
    w = world({ runs }),
    { env } = setup(t, w);
  assert.equal((await collect(env, w.transport)).reason, 'BUDGET_EXHAUSTED');
});

test('a generation hidden behind a later attempt still counts', async (t) => {
  const runs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, run_attempt: 2 })),
    jobs = Object.fromEntries(
      runs.flatMap((run) => [
        [`${run.id}/1`, [{ steps: [step(NOW - 60000)] }]],
        [`${run.id}/2`, [{ steps: [step(NOW - 60000, 'skipped')] }]],
      ]),
    ),
    w = world({ runs, jobs }),
    { env } = setup(t, w);
  assert.equal((await collect(env, w.transport)).reason, 'BUDGET_EXHAUSTED');
});

test('runs refused at the gate, and steps that were skipped, spend no budget', async (t) => {
  const skipped = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      run_attempt: 1,
      conclusion: 'skipped',
    })),
    idle = Array.from({ length: 20 }, (_, i) => ({ id: i + 100, run_attempt: 1 })),
    jobs = Object.fromEntries(
      idle.map((run) => [`${run.id}/1`, [{ steps: [step(NOW - 60000, 'skipped')] }]]),
    ),
    w = world({ runs: [...skipped, ...idle], jobs }),
    { env } = setup(t, w);
  assert.equal((await collect(env, w.transport)).state, 'ready');
  // The gate's refusals cost no read, so a busy month of bot pull requests stays cheap.
  assert.equal(w.state.reads.filter((path) => path.endsWith('/jobs')).length, idle.length);
});

const manualEnv = (change = {}) => ({
  TRANSLATE_EVENT_NAME: 'workflow_dispatch',
  TRANSLATE_KIND: 'pull',
  TRANSLATE_NUMBER: '7',
  ...change,
});
test('a dry manual run validates and stops', async (t) => {
  const w = world();
  w.state.eventName = 'workflow_dispatch';
  w.state.permission = 'maintain';
  const { env } = setup(t, w, manualEnv({ TRANSLATE_DRY_RUN: 'true' }));
  assert.deepEqual(await collect(env, w.transport), {
    state: 'refused',
    reason: 'DRY_RUN_VALIDATED',
  });
});

test('a live manual run needs an administrator, who may also ask for an app item', async (t) => {
  const w = world();
  w.state.eventName = 'workflow_dispatch';
  w.state.permission = 'maintain';
  assert.equal((await collect(setup(t, w, manualEnv()).env, w.transport)).reason, 'NOT_ELIGIBLE');
  w.state.permission = 'admin';
  w.state.item.user = { login: 'mia-jian[bot]', type: 'Bot' };
  const result = await collect(setup(t, w, manualEnv()).env, w.transport);
  assert.equal(result.state, 'ready');
  assert.equal(result.context.id, 70);
});

// The literal CLI, since a red or green run is what the owner sees on a pull request.
const script = resolve(import.meta.dirname, 'translate-run.mjs');
function cli(t, args, fixture, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'translate-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'fetch.mjs'),
    output = join(dir, 'output'),
    summary = join(dir, 'summary');
  writeFileSync(fake, fixture);
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ action: 'opened', pull_request: { number: 7, id: 70 } }));
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: `--import=${fake}`,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_EVENT_PATH: event,
      GITHUB_TOKEN: 'synthetic-reader',
      TRANSLATE_REPOSITORY: 'lucasaarch/jian',
      TRANSLATE_EVENT_NAME: 'pull_request_target',
      TRANSLATE_REF: 'refs/heads/main',
      TRANSLATE_DEFAULT_BRANCH: 'main',
      TRANSLATE_ACTOR: 'person',
      TRANSLATE_RUN_ID: '500',
      TRANSLATE_RUN_ATTEMPT: '1',
      TRANSLATE_DRY_RUN: 'false',
      SOURCE_SHA: sha,
      ...env,
    },
  });
  return {
    ...result,
    output: readFileSync(output, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
  };
}
const fixture = (item) => `
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname.replace('/repos/lucasaarch/jian', '');
  const json = (data) => new Response(JSON.stringify(data));
  if (path === '') return json({ full_name: 'lucasaarch/jian', private: false, visibility: 'public', default_branch: 'main' });
  if (path === '/actions/runs/500') return json({ id: 500, path: '.github/workflows/translate.yml', event: 'pull_request_target', run_attempt: 1, status: 'in_progress', repository: { full_name: 'lucasaarch/jian' } });
  if (path === '/pulls/7') return json(${JSON.stringify(item)});
  if (path.endsWith('/runs')) return json({ workflow_runs: [] });
  return new Response('{}', { status: 404 });
};`;
const openPull = {
  number: 7,
  id: 70,
  state: 'open',
  title: 'Falha',
  body: 'Corpo',
  user: { login: 'person', type: 'User' },
  base: { ref: 'main' },
};

test('a refusal ends the step green and says why; nothing about the text reaches the output', (t) => {
  const result = cli(t, ['collect'], fixture({ ...openPull, body: 'password: hunter2' }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'ready=false\n');
  assert.equal(result.summary, 'Translation: UNSAFE_SOURCE\n');
  assert.doesNotMatch(result.stdout + result.output + result.summary, /hunter2/);
});

test('an admitted run hands on metadata only', (t) => {
  const result = cli(t, ['collect'], fixture(openPull));
  assert.equal(result.status, 0, result.stderr);
  const [ready, context] = result.output.trim().split('\n');
  assert.equal(ready, 'ready=true');
  const parsed = JSON.parse(context.slice('context='.length));
  assert.equal(parsed.id, 70);
  assert.match(parsed.contentHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(context, /Falha|Corpo/);
});

test('something broken ends the step red', (t) => {
  const result = cli(t, ['collect'], fixture(openPull), { TRANSLATE_REF: 'refs/heads/other' });
  assert.equal(result.status, 1);
  assert.equal(result.output, 'ready=false\n');
  assert.equal(result.summary, 'Translation: CONTEXT_REFUSED\n');
});

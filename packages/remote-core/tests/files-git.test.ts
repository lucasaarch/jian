import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { answerFilesOp } from '../src/index.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'jian-git-')));
after(() => rmSync(base, { recursive: true, force: true }));
const marker = join(base, 'marker');

/** The test's own git calls skip the traps it set, so only the worker's calls could trip them. */
const QUIET = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'filter.x.clean=cat',
  '-c',
  'filter.x.smudge=cat',
  '-c',
  'filter.x.required=false',
];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();

let counter = 0;
/** A repository with a hook and filters that would leave a marker if git ever ran them. */
function repository() {
  const root = join(base, `repo-${counter++}`);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'ana@example.test');
  git(root, 'config', 'user.name', 'Ana Test');
  writeFileSync(join(root, '.gitattributes'), 'tracked.txt filter=x\n');
  writeFileSync(join(root, 'tracked.txt'), 'one\n');
  writeFileSync(join(root, 'old-name.txt'), 'rename me please, this is long enough to match\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  const touch = `touch ${marker}`;
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n${touch}\n`, {
    mode: 0o755,
  });
  git(root, 'config', 'filter.x.smudge', touch);
  git(root, 'config', 'filter.x.clean', touch);
  git(root, 'config', 'filter.x.required', 'true');
  return root;
}

test('status sees modified, untracked and renamed files without running anything', async () => {
  const root = repository();
  writeFileSync(join(root, 'tracked.txt'), 'two\n');
  writeFileSync(join(root, 'new.txt'), 'new\n');
  git(root, ...QUIET, 'mv', 'old-name.txt', 'renamed.txt');
  const answer = await answerFilesOp({ op: 'git-status', root }, { refused: [] });
  assert.ok(answer.ok && answer.op === 'git-status');
  assert.equal(answer.top, root);
  assert.ok(answer.filters.includes('filter.x.smudge'));
  const records = answer.status.split('\0');
  assert.ok(records.includes(' M tracked.txt'));
  assert.ok(records.includes('?? new.txt'));
  assert.ok(records.includes('R  renamed.txt'));
  assert.equal(answer.diff, undefined);
  assert.equal(existsSync(marker), false);
});

test('against a commit the diff lists what was committed since', async () => {
  const root = repository();
  const first = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'tracked.txt'), 'two\n');
  git(root, ...QUIET, 'add', 'tracked.txt');
  git(root, ...QUIET, 'commit', '-q', '-m', 'second');
  rmSync(marker, { force: true });
  const answer = await answerFilesOp({ op: 'git-status', root, against: first }, { refused: [] });
  assert.ok(answer.ok && answer.op === 'git-status');
  assert.equal(answer.diff, 'M\0tracked.txt\0');
  assert.equal(existsSync(marker), false);
});

test('git-file returns the committed and the working side', async () => {
  const root = repository();
  writeFileSync(join(root, 'tracked.txt'), 'two\n');
  writeFileSync(join(root, 'fresh.txt'), 'fresh\n');
  const ask = (path: string) =>
    answerFilesOp(
      { op: 'git-file', root, path, against: 'HEAD', maxBytes: 100_000 },
      { refused: [] },
    );
  assert.deepEqual(await ask('tracked.txt'), {
    ok: true,
    op: 'git-file',
    before: 'one\n',
    after: 'two\n',
  });
  assert.deepEqual(await ask('fresh.txt'), {
    ok: true,
    op: 'git-file',
    before: null,
    after: 'fresh\n',
  });
  rmSync(join(root, 'tracked.txt'));
  assert.deepEqual(await ask('tracked.txt'), {
    ok: true,
    op: 'git-file',
    before: 'one\n',
    after: null,
  });
  writeFileSync(join(root, 'fresh.txt'), Buffer.from([1, 0, 2]));
  const binary = await ask('fresh.txt');
  assert.ok(binary.ok && binary.op === 'git-file' && binary.binary === true);
  assert.equal(existsSync(marker), false);
});

test('a name that starts like pathspec magic is read as a plain name', async () => {
  const root = repository();
  writeFileSync(join(root, ':(top)x'), 'literal\n');
  const status = await answerFilesOp({ op: 'git-status', root }, { refused: [] });
  assert.ok(status.ok && status.op === 'git-status');
  assert.ok(status.status.split('\0').includes('?? :(top)x'));
  const file = await answerFilesOp(
    { op: 'git-file', root, path: ':(top)x', against: 'HEAD', maxBytes: 1000 },
    { refused: [] },
  );
  assert.deepEqual(file, { ok: true, op: 'git-file', before: null, after: 'literal\n' });
});

test('a working file that links outside the repository is refused', async () => {
  const root = repository();
  const outside = join(base, 'outside.txt');
  writeFileSync(outside, 'secret\n');
  symlinkSync(outside, join(root, 'link.txt'));
  const answer = await answerFilesOp(
    { op: 'git-file', root, path: 'link.txt', against: 'HEAD', maxBytes: 1000 },
    { refused: [] },
  );
  assert.ok(!answer.ok && answer.problem === 'refused');
});

test('a folder that is not a repository, or only inside one, is not-repository', async () => {
  const plain = join(base, `plain-${counter++}`);
  mkdirSync(plain);
  const none = await answerFilesOp({ op: 'git-status', root: plain }, { refused: [] });
  assert.ok(!none.ok && none.problem === 'not-repository');
  const root = repository();
  mkdirSync(join(root, 'sub'));
  const sub = await answerFilesOp({ op: 'git-status', root: join(root, 'sub') }, { refused: [] });
  assert.ok(!sub.ok && sub.problem === 'not-repository');
});

test('a repository inside a refused folder is refused', async () => {
  const root = repository();
  for (const op of [
    { op: 'git-status', root },
    { op: 'merge-base', root, base: 'main' },
  ]) {
    const answer = await answerFilesOp(op, { refused: [base] });
    assert.ok(!answer.ok && answer.problem === 'refused');
  }
});

test('merge-base returns the sha and refuses a missing base', async () => {
  const root = repository();
  const sha = git(root, 'rev-parse', 'HEAD');
  assert.deepEqual(await answerFilesOp({ op: 'merge-base', root, base: 'main' }, { refused: [] }), {
    ok: true,
    op: 'merge-base',
    sha,
  });
  const missing = await answerFilesOp({ op: 'merge-base', root, base: 'nope' }, { refused: [] });
  assert.ok(!missing.ok && missing.problem === 'failed');
});

const ask = (op: object) => answerFilesOp(op, { refused: [] });

test('an empty repository has changes and no committed side', async () => {
  const root = join(base, `empty-${counter++}`);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  const status = await ask({ op: 'git-status', root });
  assert.ok(status.ok && status.op === 'git-status' && status.status === '?? a.txt\0');
  const file = await ask({ op: 'git-file', root, path: 'a.txt', against: 'HEAD', maxBytes: 100 });
  assert.deepEqual(file, { ok: true, op: 'git-file', before: null, after: 'a\n' });
  const bad = await ask({
    op: 'git-file',
    root,
    path: 'a.txt',
    against: 'a'.repeat(40),
    maxBytes: 100,
  });
  assert.ok(!bad.ok && bad.problem === 'failed');
});

test('a commit that does not exist is failed, a folder is not-file', async () => {
  const root = repository();
  mkdirSync(join(root, 'dir'));
  writeFileSync(join(root, 'dir', 'f.txt'), 'f\n');
  git(root, ...QUIET, 'add', '-A');
  git(root, ...QUIET, 'commit', '-q', '-m', 'dir');
  const bad = await ask({
    op: 'git-file',
    root,
    path: 'tracked.txt',
    against: 'b'.repeat(40),
    maxBytes: 100,
  });
  assert.ok(!bad.ok && bad.problem === 'failed');
  const dir = await ask({ op: 'git-file', root, path: 'dir', against: 'HEAD', maxBytes: 100 });
  assert.ok(!dir.ok && dir.problem === 'not-file');
});

test('a new file is absent, not failed, whatever language git would answer in', async (t) => {
  const root = repository();
  writeFileSync(join(root, 'fresh.txt'), 'fresh\n');
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_MESSAGES: process.env.LC_MESSAGES,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.LANG = 'de_DE.UTF-8';
  process.env.LC_ALL = 'de_DE.UTF-8';
  process.env.LC_MESSAGES = 'de_DE.UTF-8';
  const file = await ask({
    op: 'git-file',
    root,
    path: 'fresh.txt',
    against: 'HEAD',
    maxBytes: 100,
  });
  assert.deepEqual(file, { ok: true, op: 'git-file', before: null, after: 'fresh\n' });
});

test('git settings in the worker environment change nothing', async (t) => {
  const root = repository();
  writeFileSync(join(root, 'tracked.txt'), 'two\n');
  const keys = ['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.GIT_DIR = join(base, 'nowhere');
  process.env.GIT_CONFIG_COUNT = '2';
  process.env.GIT_CONFIG_KEY_0 = 'filter.x.clean';
  process.env.GIT_CONFIG_VALUE_0 = `touch ${marker}`;
  process.env.GIT_CONFIG_KEY_1 = 'core.fsmonitor';
  process.env.GIT_CONFIG_VALUE_1 = `touch ${marker}`;
  const status = await ask({ op: 'git-status', root });
  assert.ok(status.ok && status.op === 'git-status' && status.top === root);
  assert.ok(status.status.split('\0').includes(' M tracked.txt'));
  delete process.env.GIT_CONFIG_KEY_1;
  delete process.env.GIT_CONFIG_VALUE_1;
  assert.equal(existsSync(marker), false);
});

test('output over 200,000 bytes is too-large, an in-repo link is not-file', async () => {
  const root = repository();
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(200_001));
  const big = await ask({
    op: 'git-file',
    root,
    path: 'big.txt',
    against: 'HEAD',
    maxBytes: 500_000,
  });
  assert.ok(!big.ok && big.problem === 'too-large');
  for (let i = 0; i < 4000; i++) writeFileSync(join(root, `${'n'.repeat(60)}-${i}.txt`), '');
  const status = await ask({ op: 'git-status', root });
  assert.ok(!status.ok && status.problem === 'too-large');
  const small = repository();
  symlinkSync('tracked.txt', join(small, 'inner.txt'));
  const link = await ask({
    op: 'git-file',
    root: small,
    path: 'inner.txt',
    against: 'HEAD',
    maxBytes: 100,
  });
  assert.ok(!link.ok && link.problem === 'not-file');
});

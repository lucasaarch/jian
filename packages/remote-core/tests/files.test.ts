import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  REMOTE_FILES_CAPABILITY,
  REMOTE_FILES_MAX_FIND_CHARS,
  REMOTE_FILES_MAX_READ_BYTES,
  REMOTE_FILES_MAX_SEARCH_CHARS,
  REMOTE_FILES_MAX_TEXT,
  REMOTE_FILES_RESULT_BYTES,
  type RemoteFilesAnswer,
  type RemoteFilesOp,
  type RemoteTask,
  remoteFilesAnswerSchema,
  remoteFilesOpSchema,
} from '@jian/contracts';
import {
  FILES_CAPABILITY,
  MAX_FIND_CHARS,
  MAX_READ_BYTES,
  MAX_SEARCH_CHARS,
  MAX_TEXT,
  RESULT_BYTES,
} from '../src/files/limits.ts';
import { writeAtomic } from '../src/files/text.ts';
import { parseFilesOp } from '../src/files/validate.ts';
import { answerFilesOp, describeTask, detectCapabilities, executeFilesTask } from '../src/index.ts';

const base = mkdtempSync(join(tmpdir(), 'jian-files-'));
after(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
const folder = () => {
  const path = join(base, `case-${counter++}`);
  mkdirSync(path);
  return path;
};
/** The config folder stand-in: a worker refuses its own, wherever it lives. */
const secrets = () => {
  const path = join(base, `secrets-${counter++}`);
  mkdirSync(path);
  writeFileSync(join(path, 'config.json'), '{"token":"synthetic-token"}');
  return path;
};

const ask = (op: RemoteFilesOp, refused: string[] = [secrets()], env?: NodeJS.ProcessEnv) =>
  answerFilesOp(op, { refused, ...(env ? { env } : {}) });
const ok = <T extends RemoteFilesAnswer['op']>(answer: RemoteFilesAnswer, op: T) => {
  assert.equal(remoteFilesAnswerSchema.safeParse(answer).success, true, JSON.stringify(answer));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.op, op);
  return answer as Extract<RemoteFilesAnswer, { ok: true; op: T }>;
};
const problem = (answer: RemoteFilesAnswer, expected: string) => {
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal((answer as { problem: string }).problem, expected);
};

test('read returns the text and the mtime; a missing path or folder is named', async () => {
  const dir = folder();
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'one\ntwo\n');
  const read = ok(await ask({ op: 'read', path: file, maxBytes: 1000 }), 'read');
  assert.equal(read.text, 'one\ntwo\n');
  assert.equal(read.bytes, 8);
  assert.equal(read.mtimeMs, statSync(file).mtimeMs);
  problem(await ask({ op: 'read', path: join(dir, 'nope'), maxBytes: 10 }), 'missing');
  problem(await ask({ op: 'read', path: dir, maxBytes: 10 }), 'not-file');
  problem(await ask({ op: 'read', path: file, maxBytes: 3 }), 'too-large');
});

test('a binary file is not read as text', async () => {
  const file = join(folder(), 'b.bin');
  writeFileSync(file, Buffer.from([1, 2, 0, 3]));
  problem(await ask({ op: 'read', path: file, maxBytes: 100 }), 'binary');
  const bytes = ok(await ask({ op: 'read-bytes', path: file, maxBytes: 100 }), 'read-bytes');
  assert.equal(bytes.base64, Buffer.from([1, 2, 0, 3]).toString('base64'));
  assert.equal(bytes.bytes, 4);
});

test('text over the result budget answers too-large with its size', async () => {
  const file = join(folder(), 'big.txt');
  // 3-byte characters: under the 400,000 character limit, far over the byte budget.
  writeFileSync(file, '€'.repeat(300_000));
  const answer = await ask({ op: 'read', path: file, maxBytes: 5_000_000 });
  problem(answer, 'too-large');
  assert.match((answer as { message: string }).message, /\d+ bytes/);
  // And a file that fits as characters but not as raw bytes for read-bytes.
  const raw = join(folder(), 'raw.bin');
  writeFileSync(raw, Buffer.alloc(400_000, 1));
  problem(await ask({ op: 'read-bytes', path: raw, maxBytes: 5_000_000 }), 'too-large');
});

test('write creates with null, refuses an existing file, and swaps only the expected mtime', async () => {
  const dir = folder();
  const file = join(dir, 'deep', 'new.txt');
  const created = ok(
    await ask({ op: 'write', path: file, content: 'hello', expectedMtimeMs: null }),
    'write',
  );
  assert.equal(created.created, true);
  assert.equal(created.bytes, 5);
  assert.equal(created.mtimeMs, statSync(file).mtimeMs);
  assert.equal(readFileSync(file, 'utf8'), 'hello');

  problem(await ask({ op: 'write', path: file, content: 'x', expectedMtimeMs: null }), 'exists');
  problem(
    await ask({ op: 'write', path: file, content: 'x', expectedMtimeMs: created.mtimeMs - 1 }),
    'changed',
  );
  problem(
    await ask({ op: 'write', path: join(dir, 'gone.txt'), content: 'x', expectedMtimeMs: 5 }),
    'changed',
  );
  assert.equal(readFileSync(file, 'utf8'), 'hello');

  const replaced = ok(
    await ask({ op: 'write', path: file, content: 'bye', expectedMtimeMs: created.mtimeMs }),
    'write',
  );
  assert.equal(replaced.created, false);
  assert.equal(readFileSync(file, 'utf8'), 'bye');
  assert.deepEqual(readdirSync(join(dir, 'deep')), ['new.txt']);
});

test('write keeps the mode of the file it replaces and writes through a link', async () => {
  if (process.platform === 'win32') return;
  const dir = folder();
  const file = join(dir, 'run.sh');
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  const link = join(dir, 'link.sh');
  symlinkSync(file, link);
  const { mtimeMs } = statSync(file);
  ok(await ask({ op: 'write', path: link, content: 'echo\n', expectedMtimeMs: mtimeMs }), 'write');
  assert.equal(statSync(file).mode & 0o777, 0o755);
  assert.equal(readFileSync(file, 'utf8'), 'echo\n');
  assert.equal(readFileSync(link, 'utf8'), 'echo\n');
});

test('a write whose rename fails leaves the old file and no partial one', async () => {
  const dir = folder();
  const file = join(dir, 'keep.txt');
  writeFileSync(file, 'original');
  await assert.rejects(
    writeAtomic(file, 'replacement', undefined, {
      rename: async () => {
        throw new Error('disk gone');
      },
    }),
    /disk gone/,
  );
  assert.equal(readFileSync(file, 'utf8'), 'original');
  assert.deepEqual(readdirSync(dir), ['keep.txt']);

  // Writing over a folder is refused before anything is created.
  const target = join(dir, 'folder');
  mkdirSync(target);
  problem(
    await ask({ op: 'write', path: target, content: 'x', expectedMtimeMs: null }),
    'not-file',
  );
  assert.deepEqual(readdirSync(dir).sort(), ['folder', 'keep.txt']);
});

test('write-bytes writes the decoded bytes', async () => {
  const file = join(folder(), 'out.bin');
  const answer = ok(
    await ask({
      op: 'write-bytes',
      path: file,
      base64: Buffer.from([0, 255, 7]).toString('base64'),
    }),
    'write-bytes',
  );
  assert.equal(answer.bytes, 3);
  assert.deepEqual([...readFileSync(file)], [0, 255, 7]);
});

test('list reports kinds and truncation', async () => {
  const dir = folder();
  writeFileSync(join(dir, 'a'), '');
  writeFileSync(join(dir, 'b'), '');
  mkdirSync(join(dir, 'c'));
  const all = ok(await ask({ op: 'list', path: dir, limit: 10 }), 'list');
  assert.deepEqual(all.entries.map((entry) => `${entry.name}:${entry.kind}`).sort(), [
    'a:file',
    'b:file',
    'c:directory',
  ]);
  assert.equal(all.truncated, false);
  const some = ok(await ask({ op: 'list', path: dir, limit: 2 }), 'list');
  assert.equal(some.entries.length, 2);
  assert.equal(some.truncated, true);
  problem(await ask({ op: 'list', path: join(dir, 'a'), limit: 2 }), 'not-directory');
});

test('find is newest first, skips .git and node_modules, and honours the limit', async () => {
  const dir = folder();
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules'));
  mkdirSync(join(dir, '.git'));
  for (const [name, age] of [
    ['src/old.ts', 300],
    ['src/new.ts', 10],
    ['src/mid.ts', 100],
    ['node_modules/skip.ts', 1],
    ['.git/skip.ts', 1],
  ] as const) {
    const path = join(dir, name);
    writeFileSync(path, '');
    const when = new Date(Date.now() - age * 1000);
    utimesSync(path, when, when);
  }
  const found = ok(await ask({ op: 'find', path: dir, pattern: '**/*.ts', limit: 10 }), 'find');
  assert.deepEqual(found.files, [
    join(dir, 'src/new.ts'),
    join(dir, 'src/mid.ts'),
    join(dir, 'src/old.ts'),
  ]);
  const two = ok(await ask({ op: 'find', path: dir, pattern: '**/*.ts', limit: 2 }), 'find');
  assert.equal(two.files.length, 2);
  assert.equal(two.truncated, true);
});

const fixture = () => {
  const dir = folder();
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'src/a.ts'), 'alpha\nNeedle one\nbeta\ngamma\ndelta\nneedle two\n');
  writeFileSync(join(dir, 'src/b.md'), 'needle in docs\n');
  writeFileSync(join(dir, 'src/c.bin'), Buffer.from('needle\0binary'));
  writeFileSync(join(dir, 'node_modules/x.ts'), 'needle hidden\n');
  return dir;
};
const searchOp = (path: string, extra: Partial<Extract<RemoteFilesOp, { op: 'search' }>> = {}) =>
  ({
    op: 'search',
    path,
    pattern: 'needle',
    ignoreCase: false,
    contextLines: 0,
    output: 'content',
    limit: 100,
    ...extra,
  }) as RemoteFilesOp;

const rgInstalled = (() => {
  const found = (process.env.PATH ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .some((dir) => {
      try {
        return statSync(join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg')).isFile();
      } catch {
        return false;
      }
    });
  return found;
})();

test('search without ripgrep walks the tree in all three output modes', async () => {
  const dir = fixture();
  const none = { PATH: join(base, 'no-such-bin') };
  const content = ok(await ask(searchOp(dir), undefined, none), 'search');
  assert.deepEqual(content.matches, [
    `${join(dir, 'src/a.ts')}:6:needle two`,
    `${join(dir, 'src/b.md')}:1:needle in docs`,
  ]);
  const nocase = ok(
    await ask(searchOp(dir, { ignoreCase: true, glob: '*.ts' }), undefined, none),
    'search',
  );
  assert.deepEqual(nocase.matches, [
    `${join(dir, 'src/a.ts')}:2:Needle one`,
    `${join(dir, 'src/a.ts')}:6:needle two`,
  ]);
  const files = ok(await ask(searchOp(dir, { output: 'files' }), undefined, none), 'search');
  assert.deepEqual(files.matches, [join(dir, 'src/a.ts'), join(dir, 'src/b.md')]);
  const count = ok(await ask(searchOp(dir, { output: 'count' }), undefined, none), 'search');
  assert.deepEqual(count.matches, [`${join(dir, 'src/a.ts')}:1`, `${join(dir, 'src/b.md')}:1`]);
  const limited = ok(await ask(searchOp(dir, { limit: 1 }), undefined, none), 'search');
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.truncated, true);
  problem(await ask(searchOp(dir, { pattern: '(' }), undefined, none), 'failed');
});

test('search gives the same matches with ripgrep and without it', {
  skip: rgInstalled ? false : 'ripgrep is not installed on this machine',
}, async () => {
  const dir = fixture();
  const none = { PATH: join(base, 'no-such-bin') };
  for (const extra of [
    {},
    { ignoreCase: true },
    { glob: '*.md' },
    { output: 'files' as const },
    { output: 'count' as const },
    { contextLines: 1 },
  ]) {
    const withRg = ok(await ask(searchOp(dir, extra)), 'search');
    const without = ok(await ask(searchOp(dir, extra), undefined, none), 'search');
    assert.deepEqual(
      [...without.matches].sort(),
      [...withRg.matches].sort(),
      JSON.stringify(extra),
    );
  }
});

test('the worker config folder is refused, directly and through a link', async () => {
  const secret = secrets();
  const dir = folder();
  const config = join(secret, 'config.json');
  problem(await ask({ op: 'read', path: config, maxBytes: 1000 }, [secret]), 'refused');
  problem(await ask({ op: 'list', path: secret, limit: 5 }, [secret]), 'refused');
  problem(
    await ask(
      { op: 'write', path: join(secret, 'new.json'), content: 'x', expectedMtimeMs: null },
      [secret],
    ),
    'refused',
  );
  // A write that would have to create folders inside it is refused before any is made.
  problem(
    await ask(
      { op: 'write', path: join(secret, 'a', 'b.json'), content: 'x', expectedMtimeMs: null },
      [secret],
    ),
    'refused',
  );
  assert.deepEqual(readdirSync(secret), ['config.json']);
  if (process.platform === 'win32') return;
  symlinkSync(secret, join(dir, 'door'));
  symlinkSync(config, join(dir, 'file-door'));
  problem(
    await ask({ op: 'read', path: join(dir, 'door', 'config.json'), maxBytes: 1000 }, [secret]),
    'refused',
  );
  problem(
    await ask({ op: 'read', path: join(dir, 'file-door'), maxBytes: 1000 }, [secret]),
    'refused',
  );
  problem(
    await ask(
      { op: 'write', path: join(dir, 'door', 'x.json'), content: 'x', expectedMtimeMs: null },
      [secret],
    ),
    'refused',
  );
  assert.deepEqual(readdirSync(secret), ['config.json']);
  // Walking from a parent neither lists nor searches what lies in it.
  const parent = join(dir, 'parent');
  mkdirSync(parent);
  mkdirSync(join(parent, 'inner'));
  const inner = join(parent, 'inner');
  writeFileSync(join(inner, 'ok.txt'), 'synthetic-token here\n');
  const holder = mkdtempSync(join(base, 'holder-'));
  mkdirSync(join(holder, 'secret'));
  writeFileSync(join(holder, 'secret', 'config.json'), 'synthetic-token\n');
  writeFileSync(join(holder, 'plain.txt'), 'synthetic-token\n');
  const lines = ok(
    await ask(searchOp(holder, { pattern: 'synthetic-token', output: 'files' }), [
      join(holder, 'secret'),
    ]),
    'search',
  );
  assert.deepEqual(lines.matches, [join(holder, 'plain.txt')]);
  const found = ok(
    await ask({ op: 'find', path: holder, pattern: '**/*.json', limit: 10 }, [
      join(holder, 'secret'),
    ]),
    'find',
  );
  assert.deepEqual(found.files, []);
});

test('the worker copies of the contract constants and validation agree with the contract', () => {
  assert.equal(FILES_CAPABILITY, REMOTE_FILES_CAPABILITY);
  assert.equal(MAX_TEXT, REMOTE_FILES_MAX_TEXT);
  assert.equal(RESULT_BYTES, REMOTE_FILES_RESULT_BYTES);
  assert.equal(MAX_FIND_CHARS, REMOTE_FILES_MAX_FIND_CHARS);
  assert.equal(MAX_SEARCH_CHARS, REMOTE_FILES_MAX_SEARCH_CHARS);
  assert.equal(MAX_READ_BYTES, REMOTE_FILES_MAX_READ_BYTES);
  const sha = 'a'.repeat(40);
  const cases: unknown[] = [
    { op: 'read', path: '/a', maxBytes: 1 },
    { op: 'read', path: 'a', maxBytes: 1 },
    { op: 'read', path: '/a\0b', maxBytes: 1 },
    { op: 'read', path: 'C:\\a', maxBytes: 0 },
    { op: 'read', path: '/a', maxBytes: REMOTE_FILES_MAX_READ_BYTES + 1 },
    { op: 'read', path: '/a', maxBytes: 1.5 },
    { op: 'read', path: '/a', maxBytes: 1, extra: true },
    { op: 'write', path: '/a', content: '', expectedMtimeMs: null },
    { op: 'write', path: '/a', content: 'x', expectedMtimeMs: 12.5 },
    { op: 'write', path: '/a', content: 'x' },
    { op: 'write', path: '/a', content: 'x'.repeat(400_001), expectedMtimeMs: null },
    { op: 'list', path: '/a', limit: 300 },
    { op: 'list', path: '/a', limit: 301 },
    { op: 'find', path: '/a', pattern: '**/*.ts', limit: 5 },
    { op: 'find', path: '/a', pattern: '', limit: 5 },
    {
      op: 'search',
      path: '/a',
      pattern: 'x',
      ignoreCase: false,
      contextLines: 0,
      output: 'files',
      limit: 1,
    },
    {
      op: 'search',
      path: '/a',
      pattern: 'x',
      glob: '-x',
      ignoreCase: false,
      contextLines: 0,
      output: 'files',
      limit: 1,
    },
    {
      op: 'search',
      path: '/a',
      pattern: 'x',
      glob: '*.ts',
      ignoreCase: true,
      contextLines: 11,
      output: 'files',
      limit: 1,
    },
    {
      op: 'search',
      path: '/a',
      pattern: 'x',
      ignoreCase: false,
      contextLines: 0,
      output: 'lines',
      limit: 1,
    },
    { op: 'read-bytes', path: '/a', maxBytes: 5 },
    { op: 'write-bytes', path: '/a', base64: 'AAEC' },
    { op: 'write-bytes', path: '/a', base64: 'A*EC' },
    { op: 'git-status', root: '/a' },
    { op: 'git-status', root: '/a', against: sha },
    { op: 'git-status', root: '/a', against: 'abc' },
    { op: 'git-file', root: '/a', path: 'src/x.ts', against: 'HEAD', maxBytes: 10 },
    { op: 'git-file', root: '/a', path: '../x', against: 'HEAD', maxBytes: 10 },
    { op: 'git-file', root: '/a', path: 'src/x.ts', maxBytes: 10 },
    { op: 'merge-base', root: '/a', base: 'main' },
    { op: 'merge-base', root: '/a', base: '--exec' },
    { op: 'nope' },
    null,
    'read',
  ];
  for (const value of cases) {
    assert.equal(
      parseFilesOp(value) !== undefined,
      remoteFilesOpSchema.safeParse(value).success,
      JSON.stringify(value),
    );
  }
});

test('Windows-style absolute paths pass the contract and relative ones do not', () => {
  const parse = (path: string) =>
    remoteFilesOpSchema.safeParse({ op: 'list', path, limit: 1 }).success;
  assert.equal(parse('C:\\Users\\theo\\notes'), true);
  assert.equal(parse('D:/work/app'), true);
  assert.equal(parse('/srv/app'), true);
  assert.equal(parse('notes/today.txt'), false);
  assert.equal(parse('C:notes'), false);
  assert.equal(parse('\\\\server\\share'), false);
});

test('a bad op answers failed instead of throwing', async () => {
  problem(await answerFilesOp({ op: 'read', path: 'relative', maxBytes: 1 }), 'failed');
  problem(await answerFilesOp(undefined), 'failed');
});

test('git ops are not available yet', async () => {
  const answer = await ask({ op: 'merge-base', root: folder(), base: 'main' });
  assert.deepEqual(answer, {
    ok: false,
    op: 'merge-base',
    problem: 'failed',
    message: 'Not available yet.',
  });
});

test('a files task becomes a result with exit code, empty output and the answer', async () => {
  const file = join(folder(), 'a.txt');
  writeFileSync(file, 'hi');
  const task: RemoteTask = {
    id: crypto.randomUUID(),
    kind: 'files',
    command: null,
    cwd: null,
    timeoutMs: 1000,
    files: { op: 'read', path: file, maxBytes: 10 },
  };
  const result = await executeFilesTask(task, { refused: [secrets()] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.files?.ok, true);
  const failed = await executeFilesTask(
    { ...task, files: { op: 'read', path: join(file, 'x'), maxBytes: 10 } },
    { refused: [secrets()] },
  );
  assert.equal(failed.exitCode, 1);
  assert.equal(describeTask(task).kind, 'files');
  assert.doesNotMatch(JSON.stringify(describeTask(task)), /a\.txt/);
});

test('the worker advertises files-v1', async () => {
  assert.ok((await detectCapabilities()).includes(REMOTE_FILES_CAPABILITY));
});

import {
  REMOTE_FILES_CAPABILITY,
  remoteFilesAnswerSchema,
  remoteFilesOpSchema,
  remoteResultSchema,
  remoteTaskSchema,
} from '@jian/contracts';
import { describe, expect, it } from 'vitest';

const sha = 'a'.repeat(40);
const root = '/work/demo';

const ops: Record<string, [unknown, unknown]> = {
  read: [
    { op: 'read', path: '/work/a.txt', maxBytes: 1000 },
    { op: 'read', path: 'a.txt', maxBytes: 1000 },
  ],
  write: [
    { op: 'write', path: 'C:\\work\\a.txt', content: 'hi', expectedMtimeMs: null },
    { op: 'write', path: '/work/a.txt', content: 'x'.repeat(400_001), expectedMtimeMs: null },
  ],
  list: [
    { op: 'list', path: 'D:/work', limit: 300 },
    { op: 'list', path: '/work', limit: 301 },
  ],
  find: [
    { op: 'find', path: root, pattern: '**/*.ts', limit: 1000 },
    { op: 'find', path: root, pattern: '', limit: 10 },
  ],
  search: [
    {
      op: 'search',
      path: root,
      pattern: 'todo',
      ignoreCase: true,
      contextLines: 2,
      output: 'content',
      limit: 2000,
    },
    {
      op: 'search',
      path: root,
      pattern: 'todo',
      ignoreCase: true,
      contextLines: 2,
      output: 'lines',
      limit: 10,
    },
  ],
  'read-bytes': [
    { op: 'read-bytes', path: root, maxBytes: 20 * 1024 * 1024 },
    { op: 'read-bytes', path: root, maxBytes: 20 * 1024 * 1024 + 1 },
  ],
  'write-bytes': [
    { op: 'write-bytes', path: '/work/a.bin', base64: 'aGk=' },
    { op: 'write-bytes', path: '/work/a.bin', base64: 'not base64!' },
  ],
  'git-status': [
    { op: 'git-status', root, against: sha },
    { op: 'git-status', root, against: 'main' },
  ],
  'git-file': [
    { op: 'git-file', root, path: 'src/a.ts', against: 'HEAD', maxBytes: 500_000 },
    { op: 'git-file', root, path: 'src/a.ts', against: 'main', maxBytes: 500_000 },
  ],
  'merge-base': [
    { op: 'merge-base', root, base: 'origin/main' },
    { op: 'merge-base', root: 'relative', base: 'origin/main' },
  ],
};

const answers: Record<string, [unknown, unknown]> = {
  read: [
    { ok: true, op: 'read', text: 'hi', mtimeMs: 1.5, bytes: 2 },
    { ok: true, op: 'read', text: 'hi', bytes: 2 },
  ],
  write: [
    { ok: true, op: 'write', mtimeMs: 1, bytes: 2, created: true },
    { ok: true, op: 'write', mtimeMs: 1, bytes: 2 },
  ],
  list: [
    { ok: true, op: 'list', entries: [{ name: 'a', kind: 'file' }], truncated: false },
    { ok: true, op: 'list', entries: [{ name: 'a', kind: 'socket' }], truncated: false },
  ],
  find: [
    { ok: true, op: 'find', files: ['/a'], truncated: true },
    { ok: true, op: 'find', files: 'a', truncated: true },
  ],
  search: [
    { ok: true, op: 'search', matches: ['a:1:x'], truncated: false },
    { ok: true, op: 'search', matches: [1], truncated: false },
  ],
  'read-bytes': [
    { ok: true, op: 'read-bytes', base64: 'aGk=', bytes: 2 },
    { ok: true, op: 'read-bytes', base64: 'x'.repeat(400_001), bytes: 2 },
  ],
  'write-bytes': [
    { ok: true, op: 'write-bytes', bytes: 2 },
    { ok: true, op: 'write-bytes' },
  ],
  'git-status': [
    { ok: true, op: 'git-status', top: root, filters: [], status: '', diff: '' },
    { ok: true, op: 'git-status', top: root, status: '' },
  ],
  'git-file': [
    { ok: true, op: 'git-file', before: null, after: 'x', binary: false },
    { ok: true, op: 'git-file', before: 'x'.repeat(500_001), after: null },
  ],
  'merge-base': [
    { ok: true, op: 'merge-base', sha },
    { ok: true, op: 'merge-base', sha: 'abc' },
  ],
};

describe('files tasks contract', () => {
  it('advertises files-v1', () => {
    expect(REMOTE_FILES_CAPABILITY).toBe('files-v1');
  });

  for (const [name, [valid, invalid]] of Object.entries(ops)) {
    it(`op ${name}: accepts a valid request and refuses an invalid one`, () => {
      expect(remoteFilesOpSchema.safeParse(valid).success).toBe(true);
      expect(remoteFilesOpSchema.safeParse(invalid).success).toBe(false);
    });
  }

  for (const [name, [valid, invalid]] of Object.entries(answers)) {
    it(`answer ${name}: accepts a valid answer and refuses an invalid one`, () => {
      expect(remoteFilesAnswerSchema.safeParse(valid).success).toBe(true);
      expect(remoteFilesAnswerSchema.safeParse(invalid).success).toBe(false);
    });
  }

  it('refuses NUL in a path and a relative or UNC-less path', () => {
    const base = { op: 'read', maxBytes: 1 };
    expect(remoteFilesOpSchema.safeParse({ ...base, path: '/a\0b' }).success).toBe(false);
    expect(remoteFilesOpSchema.safeParse({ ...base, path: './a' }).success).toBe(false);
  });

  it('answers a problem for any op, with a bounded message', () => {
    const failure = { ok: false, op: 'write', problem: 'changed', message: 'Changed since read.' };
    expect(remoteFilesAnswerSchema.safeParse(failure).success).toBe(true);
    expect(remoteFilesAnswerSchema.safeParse({ ...failure, problem: 'weird' }).success).toBe(false);
    expect(
      remoteFilesAnswerSchema.safeParse({ ...failure, message: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('carries files on tasks and results', () => {
    const task = {
      id: crypto.randomUUID(),
      kind: 'files',
      command: null,
      cwd: null,
      timeoutMs: 1000,
      files: ops.read?.[0],
    };
    expect(remoteTaskSchema.safeParse(task).success).toBe(true);
    const result = {
      taskId: crypto.randomUUID(),
      exitCode: 0,
      stdout: '',
      stderr: '',
      files: answers.read?.[0],
    };
    expect(remoteResultSchema.safeParse(result).success).toBe(true);
  });
});

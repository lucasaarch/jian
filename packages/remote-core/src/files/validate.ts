import type { RemoteFilesOp } from '@jian/contracts';
import { MAX_GIT_BYTES, MAX_READ_BYTES, MAX_TEXT } from './limits.ts';

/**
 * Checks a task's `files` the way `remoteFilesOpSchema` does, without Zod (see limits.ts). The
 * test compares the two on a table of good and bad operations; change them together.
 */
type Check = (value: unknown) => boolean;

const text =
  (max: number, extra: (value: string) => boolean = () => true): Check =>
  (value) =>
    typeof value === 'string' && value.length <= max && !value.includes('\0') && extra(value);
const integer =
  (min: number, max: number): Check =>
  (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const path = text(4096, (value) => /^(\/|[A-Za-z]:[\\/])/.test(value));
const pattern = (max: number) => text(max, (value) => value.length >= 1);
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const control = /[\u0000-\u001f\u007f]/;
const plain = (max: number) =>
  text(
    max,
    (value) =>
      value.length >= 1 && !value.startsWith('-') && !control.test(value) && value === value.trim(),
  );
const boolean: Check = (value) => typeof value === 'boolean';
const sha: Check = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const repoPath = text(
  4096,
  (value) =>
    value.length >= 1 &&
    !value.startsWith('-') &&
    !/^([\\/]|[A-Za-z]:)/.test(value) &&
    !value.split(/[\\/]/).includes('..'),
);
const oneOf =
  (...allowed: string[]): Check =>
  (value) =>
    typeof value === 'string' && allowed.includes(value);

const SHAPES: Record<string, Record<string, Check>> = {
  read: { path, maxBytes: integer(1, MAX_READ_BYTES) },
  write: {
    path,
    // Any characters: unlike a path, a file's text may hold NUL.
    content: (value) => typeof value === 'string' && value.length <= MAX_TEXT,
    expectedMtimeMs: (value) =>
      value === null || (typeof value === 'number' && Number.isFinite(value)),
  },
  list: { path, limit: integer(1, 300) },
  find: { path, pattern: pattern(500), limit: integer(1, 1000) },
  search: {
    path,
    pattern: pattern(2000),
    glob: plain(200),
    ignoreCase: boolean,
    contextLines: integer(0, 10),
    output: oneOf('content', 'files', 'count'),
    limit: integer(1, 2000),
  },
  'read-bytes': { path, maxBytes: integer(1, MAX_READ_BYTES) },
  'write-bytes': {
    path,
    base64: text(MAX_TEXT, (value) => /^[A-Za-z0-9+/]*={0,2}$/.test(value)),
  },
  'git-status': { root: path, against: sha },
  'git-file': {
    root: path,
    path: repoPath,
    against: (value) => value === 'HEAD' || sha(value),
    maxBytes: integer(1, MAX_GIT_BYTES),
  },
  'merge-base': { root: path, base: plain(256) },
};
const OPTIONAL = new Set(['glob', 'against']);

/** The operation when it is valid, else undefined. No extra keys, as the schema is strict. */
export function parseFilesOp(value: unknown): RemoteFilesOp | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const shape =
    typeof record.op === 'string' && Object.hasOwn(SHAPES, record.op)
      ? SHAPES[record.op]
      : undefined;
  if (!shape) return undefined;
  for (const key of Object.keys(record))
    if (key !== 'op' && !Object.hasOwn(shape, key)) return undefined;
  for (const [key, check] of Object.entries(shape)) {
    if (!Object.hasOwn(record, key) || record[key] === undefined) {
      if (OPTIONAL.has(key) && record.op !== 'git-file') continue;
      return undefined;
    }
    if (!check(record[key])) return undefined;
  }
  return record as RemoteFilesOp;
}

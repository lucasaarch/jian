import { describe, expect, it } from 'vitest';
import type { CodeDiff } from '../../../lib/api';
import { wholeRows } from './file-diff';

const file = ['const a = 1;', 'const b = 3;', 'const c = 3;', 'const d = 4;', 'const e = 5;'];
const diff = (patch: Partial<CodeDiff> = {}): CodeDiff => ({
  path: 'src/letters.ts',
  language: 'typescript',
  additions: 1,
  deletions: 1,
  hunks: [
    {
      oldStart: 2,
      oldLines: 2,
      newStart: 2,
      newLines: 2,
      lines: [
        { kind: 'del', old: 2, text: 'const b = 2;' },
        { kind: 'add', new: 2, text: 'const b = 3;' },
        { kind: 'context', old: 3, new: 3, text: 'const c = 3;' },
      ],
    },
  ],
  ...patch,
});
const shape = (rows: ReturnType<typeof wholeRows>) =>
  rows.map(({ line }) => `${line.kind}:${line.old ?? ''}/${line.new ?? ''}`);

describe('a whole file with its changes laid in', () => {
  it('keeps every line as it is now, with the removed ones where they were', () => {
    expect(shape(wholeRows(diff(), file))).toEqual([
      'context:/1',
      'del:2/',
      'add:/2',
      'context:3/3',
      'context:/4',
      'context:/5',
    ]);
  });

  it('places lines only removed after the line git names', () => {
    const removed = diff({
      hunks: [
        {
          oldStart: 3,
          oldLines: 1,
          newStart: 2,
          newLines: 0,
          lines: [{ kind: 'del', old: 3, text: 'const gone = 0;' }],
        },
      ],
    });

    expect(shape(wholeRows(removed, file)).slice(0, 4)).toEqual([
      'context:/1',
      'context:/2',
      'del:3/',
      'context:/3',
    ]);
  });

  it('stops at the last change a cut diff shows, since what follows may hold more', () => {
    expect(shape(wholeRows(diff({ truncated: true }), file)).at(-1)).toBe('context:3/3');
  });
});

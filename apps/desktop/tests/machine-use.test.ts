import type { RemoteTask } from '@jian/contracts';
import { expect, it } from 'vitest';
import { shownUse } from '../src/main/machines/use';

const files = (op: Record<string, unknown>) =>
  ({ kind: 'files', files: op }) as unknown as Pick<RemoteTask, 'kind' | 'files'>;

it('shows an agent working with files, and says nothing for the panel reading changes', () => {
  for (const op of ['read', 'write', 'list', 'find', 'search', 'read-bytes', 'write-bytes']) {
    expect(shownUse(files({ op, path: '/srv/a' }))).toBe('files');
  }
  for (const op of ['git-status', 'git-file', 'merge-base']) {
    expect(shownUse(files({ op, root: '/srv/site' }))).toBeUndefined();
  }
  expect(shownUse({ kind: 'computer' } as never)).toBe('computer');
  expect(shownUse({ kind: 'shell' } as never)).toBe('shell');
});

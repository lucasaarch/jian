import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CodeDiff, ToolStep } from '../../lib/api';
import { CodeChanges } from './code-change';

const diff: CodeDiff = {
  path: 'services/payments/retry.ts',
  language: 'typescript',
  additions: 2,
  deletions: 1,
  hunks: [
    {
      oldStart: 18,
      oldLines: 3,
      newStart: 18,
      newLines: 4,
      header: 'export function withRetry(',
      lines: [
        { kind: 'context', old: 18, new: 18, text: '  const max = options.maxAttempts ?? 5;' },
        { kind: 'del', old: 19, text: '  const backoff = 100;' },
        { kind: 'add', new: 19, text: '  const baseBackoff = options.backoffMs ?? 200;' },
        { kind: 'add', new: 20, text: '  const jitter = () => Math.random() * baseBackoff;' },
        { kind: 'context', old: 20, new: 21, text: '  let attempt = 0;' },
      ],
    },
  ],
};
const step = (extra: Partial<ToolStep>): ToolStep => ({
  toolCallId: 'edit-1',
  toolName: 'edit_file',
  status: 'done',
  startedAt: '2026-10-29T10:00:00.000Z',
  finishedAt: '2026-10-29T10:00:01.000Z',
  ...extra,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('shows what an edit changed, line by line, numbered on each side', () => {
  act(() => root.render(<CodeChanges steps={[step({ diff })]} />));

  expect(container.querySelector('.code-change-row')?.textContent).toBe('Applied 1 edit');
  expect(container.querySelector('.code-diff-path')?.textContent).toBe(diff.path);
  expect(container.querySelector('.code-diff-hunk')?.textContent).toBe(
    '@@ -18,3 +18,4 @@ export function withRetry(',
  );
  const rows = [...container.querySelectorAll('.code-diff-line')].map((row) => [
    row.getAttribute('data-kind'),
    ...[...row.querySelectorAll('.code-diff-number')].map((cell) => cell.textContent),
  ]);
  expect(rows).toEqual([
    ['context', '18', '18'],
    ['del', '19', ''],
    ['add', '', '19'],
    ['add', '', '20'],
    ['context', '20', '21'],
  ]);
  // The code keeps its words through highlighting.
  expect(container.querySelectorAll('.code-diff-line code')[2]?.textContent).toBe(
    '  const baseBackoff = options.backoffMs ?? 200;',
  );
});

it('folds a file away and opens it again', () => {
  act(() => root.render(<CodeChanges steps={[step({ diff })]} />));
  const head = container.querySelector<HTMLButtonElement>('.code-diff-head');

  expect(head?.getAttribute('aria-expanded')).toBe('true');
  act(() => head?.click());
  expect(head?.getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('.code-diff-line')).toBeNull();
  act(() => head?.click());
  expect(container.querySelector('.code-diff-line')).not.toBeNull();
});

it('says a write made a file, and shows nothing for a step without a change', () => {
  act(() =>
    root.render(
      <CodeChanges
        steps={[
          step({ toolName: 'read_file', toolCallId: 'read-1' }),
          step({ toolCallId: 'failed', status: 'failed', diff }),
          step({ toolName: 'write_file', toolCallId: 'write-1', diff: { ...diff, created: true } }),
        ]}
      />,
    ),
  );

  expect(container.querySelectorAll('.code-change')).toHaveLength(1);
  expect(container.querySelector('.code-change-summary')?.textContent).toBe('Created a file');

  act(() => root.render(<CodeChanges steps={[step({})]} />));
  expect(container.querySelector('.code-changes')).toBeNull();
});

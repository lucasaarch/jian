import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeDiff, ToolStep } from '../../lib/api';
import { useReviewed } from '../../lib/stores/reviewed';
import { CodeChanges, FileDiff } from './code-change';

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

it('shows what an edit changed, line by line, each with its one number', () => {
  act(() => root.render(<CodeChanges steps={[step({ diff })]} />));

  const head = container.querySelector<HTMLButtonElement>('.code-diff-head');
  expect(head?.getAttribute('aria-expanded')).toBe('false');
  act(() => head?.click());
  expect(container.querySelector('.code-change')?.getAttribute('aria-label')).toBe(
    'Applied 1 edit',
  );
  expect(container.querySelector('.code-diff-path')?.textContent).toBe(diff.path);
  // Lines 1 to 17 are left out above the change, with no file to read them from: no bar.
  expect(container.querySelector('.code-diff-gap')).toBeNull();
  const rows = [...container.querySelectorAll('.code-diff-line')].map((row) => [
    row.getAttribute('data-kind'),
    ...[...row.querySelectorAll('.code-diff-number')].map((cell) => cell.textContent),
  ]);
  // One number per line: where it is now, or where it was for a line that is gone.
  expect(rows).toEqual([
    ['context', '18'],
    ['del', '19'],
    ['add', '19'],
    ['add', '20'],
    ['context', '21'],
  ]);
  // The code keeps its words through highlighting.
  expect(container.querySelectorAll('.code-diff-line code')[2]?.textContent).toBe(
    '  const baseBackoff = options.backoffMs ?? 200;',
  );
});

it('folds a file away and opens it again', () => {
  act(() => root.render(<CodeChanges steps={[step({ diff })]} />));
  const head = container.querySelector<HTMLButtonElement>('.code-diff-head');

  expect(head?.getAttribute('aria-expanded')).toBe('false');
  // Never opened, its code is not drawn at all.
  expect(container.querySelector('.code-diff-line')).toBeNull();
  act(() => head?.click());
  expect(head?.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('.code-diff-line')?.closest('[inert]')).toBeNull();
  act(() => head?.click());
  expect(head?.getAttribute('aria-expanded')).toBe('false');
  // Folded again it stays, for the fold to move, out of reach.
  expect(container.querySelector('.code-diff-line')?.closest('[inert]')).toBeTruthy();
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
  expect(container.querySelector('.code-change')?.getAttribute('aria-label')).toBe(
    'Created a file',
  );

  act(() => root.render(<CodeChanges steps={[step({})]} />));
  expect(container.querySelector('.code-changes')).toBeNull();
});

describe('marking a file as reviewed', () => {
  beforeEach(() => {
    localStorage.clear();
    useReviewed.setState({ files: {} });
  });

  const show = (shown: CodeDiff = diff, scope = 'pull:harbor#7') =>
    act(() => root.render(<FileDiff key={scope} diff={shown} open flat reviewScope={scope} />));
  const box = () => container.querySelector<HTMLElement>('[role="checkbox"]');
  const head = () => container.querySelector('.code-diff-head');
  const reviewed = () => box()?.getAttribute('aria-checked') === 'true';

  it('folds the file away when marked, and leaves it folded when unmarked', () => {
    show();
    expect(head()?.getAttribute('aria-expanded')).toBe('true');

    act(() => box()?.click());
    expect(reviewed()).toBe(true);
    expect(head()?.getAttribute('aria-expanded')).toBe('false');

    act(() => box()?.click());
    expect(reviewed()).toBe(false);
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('marking does not count as folding or opening by the head', () => {
    show();
    act(() => head()?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(reviewed()).toBe(false);
  });

  it('opens folded and marked next time', () => {
    show();
    act(() => box()?.click());
    act(() => root.unmount());
    root = createRoot(container);

    show();

    expect(reviewed()).toBe(true);
    expect(head()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('asks for another look when the file changed since', () => {
    show();
    act(() => box()?.click());
    act(() => root.unmount());
    root = createRoot(container);

    show({
      ...diff,
      hunks: diff.hunks.map((hunk) => ({
        ...hunk,
        lines: [...hunk.lines, { kind: 'add' as const, new: 22, text: 'attempt += 1;' }],
      })),
    });

    expect(reviewed()).toBe(false);
    expect(head()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps each pull request’s reviews apart', () => {
    show(diff, 'pull:harbor#7');
    act(() => box()?.click());

    show(diff, 'pull:harbor#8');

    expect(reviewed()).toBe(false);
  });

  it('offers no mark where nothing asked for one', () => {
    act(() => root.render(<FileDiff diff={diff} open />));

    expect(box()).toBeNull();
  });
});

it('keeps a long path’s file name, whole, with the folders giving way', () => {
  act(() => root.render(<FileDiff diff={diff} open />));

  expect(container.querySelector('.code-diff-file')?.textContent).toBe('retry.ts');
  expect(container.querySelector('.code-diff-path')?.getAttribute('title')).toBe(diff.path);
});

describe('what a diff leaves out', () => {
  const FILE = Array.from({ length: 60 }, (_, at) => `line ${at + 1}`);
  /** A change at line `at + 3` with git's three lines of context on each side. */
  const hunkAt = (at: number): CodeDiff['hunks'][number] => ({
    oldStart: at,
    oldLines: 7,
    newStart: at,
    newLines: 7,
    lines: [
      { kind: 'context', old: at, new: at, text: `line ${at}` },
      { kind: 'context', old: at + 1, new: at + 1, text: `line ${at + 1}` },
      { kind: 'context', old: at + 2, new: at + 2, text: `line ${at + 2}` },
      { kind: 'del', old: at + 3, text: 'gone' },
      { kind: 'add', new: at + 3, text: `line ${at + 3}` },
      { kind: 'context', old: at + 4, new: at + 4, text: `line ${at + 4}` },
      { kind: 'context', old: at + 5, new: at + 5, text: `line ${at + 5}` },
      { kind: 'context', old: at + 6, new: at + 6, text: `line ${at + 6}` },
    ],
  });
  const spread: CodeDiff = {
    path: 'src/pricing.ts',
    additions: 2,
    deletions: 2,
    hunks: [hunkAt(5), hunkAt(40)],
  };
  const labels = () =>
    [...container.querySelectorAll('.code-diff-gap-label')].map((label) => label.textContent);
  const numbers = () =>
    [...container.querySelectorAll('.code-diff-line')]
      .filter((row) => row.getAttribute('data-kind') !== 'del')
      .map((row) => Number(row.querySelector('.code-diff-number')?.textContent));
  const press = async (name: string, at = 0) => {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>('.code-diff-gap button'),
    ].filter((item) => item.getAttribute('aria-label') === name)[at];
    await act(async () => button?.click());
  };
  const BELOW = 'Show more lines below this change';
  const ABOVE = 'Show more lines above this change';

  it('says what lies between changes in place of a hunk header, with nothing to press unread', () => {
    act(() => root.render(<FileDiff diff={spread} open />));

    // The edges say nothing they could act on, so only the gap between changes is told.
    expect(labels()).toEqual(['28 unmodified lines']);
    expect(container.querySelector('.code-diff-gap button')).toBeNull();
    expect(container.textContent).not.toContain('@@');
  });

  it('brings hidden lines in from either side, numbered, until none is left', async () => {
    let reads = 0;
    const readLines = async () => {
      reads += 1;
      return FILE;
    };
    act(() => root.render(<FileDiff diff={spread} open readLines={readLines} />));
    expect(labels()).toEqual([
      'More unmodified lines',
      '28 unmodified lines',
      'More unmodified lines',
    ]);

    // Down from the first change, by a step of twenty: 12 to 31, leaving 8.
    await press(BELOW, 0);
    expect(labels()).toEqual([
      'More unmodified lines',
      '8 unmodified lines',
      'More unmodified lines',
    ]);
    expect(numbers().slice(7, 9)).toEqual([12, 13]);
    expect(numbers()).toContain(31);
    expect(numbers()).not.toContain(32);

    // Up from the second change takes the rest, and the two changes read as one run of lines.
    await press(ABOVE, 1);
    expect(labels()).toEqual(['More unmodified lines', 'More unmodified lines']);
    await press(ABOVE, 0);
    await press(BELOW, 0);
    expect(labels()).toEqual([]);
    expect(numbers()).toEqual(FILE.map((_, at) => at + 1));
    expect(
      [...container.querySelectorAll('.code-diff-line')].at(-1)?.querySelector('code')?.textContent,
    ).toBe('line 60');
    expect(reads).toBe(1);
  });

  it('offers nothing past a last change that reached the end of the file', () => {
    const last = hunkAt(40);
    const ended = { ...last, lines: last.lines.slice(0, -1), newLines: 6, oldLines: 6 };
    act(() =>
      root.render(
        <FileDiff diff={{ ...spread, hunks: [ended] }} open readLines={async () => FILE} />,
      ),
    );

    expect(labels()).toEqual(['More unmodified lines']);
  });

  it('never shows lines from a file that no longer matches the diff, and can try again', async () => {
    const stale = FILE.map((line) => `${line} edited`);
    let answer = async () => stale;
    act(() => root.render(<FileDiff diff={spread} open readLines={() => answer()} />));

    await press(BELOW, 0);
    expect(numbers()).not.toContain(12);
    expect(labels()).toContain('Could not read these lines. Try again.');

    answer = async () => {
      throw new Error('offline');
    };
    await press(BELOW, 0);
    expect(numbers()).not.toContain(12);
    expect(labels()).toContain('Could not read these lines. Try again.');

    answer = async () => FILE;
    await press(BELOW, 0);
    expect(numbers()).toContain(12);
    expect(labels()).toContain('8 unmodified lines');
  });

  it('starts over when the diff itself changes', async () => {
    const readLines = async () => FILE;
    act(() => root.render(<FileDiff diff={spread} open readLines={readLines} />));
    await press(BELOW, 0);
    expect(numbers()).toContain(12);

    act(() =>
      root.render(
        <FileDiff
          diff={{ ...spread, hunks: [hunkAt(5), hunkAt(30)] }}
          open
          readLines={readLines}
        />,
      ),
    );
    expect(numbers()).not.toContain(12);
    expect(labels()).toContain('18 unmodified lines');
  });

  it('offers no reading on a cut diff, where a gap may hide changes too', () => {
    act(() =>
      root.render(
        <FileDiff diff={{ ...spread, truncated: true }} open readLines={async () => FILE} />,
      ),
    );

    expect(labels()).toEqual(['More lines']);
    expect(container.querySelector('.code-diff-gap button')).toBeNull();
  });

  it('marks what changed inside a line replaced by another, and not a line only added', () => {
    const changed: CodeDiff = {
      path: 'src/pricing.ts',
      additions: 2,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: 'del', old: 1, text: 'const price = 10;' },
            { kind: 'add', new: 1, text: 'const price = 12;' },
            { kind: 'add', new: 2, text: 'const tax = 3;' },
          ],
        },
      ],
    };
    act(() => root.render(<FileDiff diff={changed} open />));

    const rows = [...container.querySelectorAll('.code-diff-line')];
    const marked = (row?: Element) =>
      [...(row?.querySelectorAll('.code-diff-changed') ?? [])].map((mark) => mark.textContent);
    expect(marked(rows[0])).toEqual(['0']);
    expect(marked(rows[1])).toEqual(['2']);
    expect(marked(rows[2])).toEqual([]);
    // Marking keeps the words.
    expect(rows[1]?.querySelector('code')?.textContent).toBe('const price = 12;');
  });
});

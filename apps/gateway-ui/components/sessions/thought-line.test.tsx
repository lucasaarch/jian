import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ThoughtLine } from './thought-line';

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(() => {
  act(() => root.unmount());
  element.remove();
});

const steps = [
  { key: 'a', text: 'Reading a file', status: 'done' as const },
  { key: 'b', text: 'Running a command', status: 'running' as const },
];

it('settles into the time the work took, from its own timestamps, and folds its steps', () => {
  act(() =>
    root.render(
      <ThoughtLine
        working
        steps={steps}
        startedAt={Date.now() - 4_000}
        label="Running a command"
      />,
    ),
  );
  const line = element.querySelector('.thought-line');
  expect(line?.hasAttribute('data-open')).toBe(true);
  expect(element.querySelector('.thought-head')?.getAttribute('aria-expanded')).toBe('true');

  // An old turn read again: the duration is the run's, not the time since this drew.
  act(() =>
    root.render(
      <ThoughtLine
        working={false}
        steps={steps}
        startedAt="2026-09-22T00:00:00Z"
        finishedAt="2026-09-22T00:01:12Z"
      />,
    ),
  );
  expect(element.querySelector('.thought-timer')?.textContent).toBe('1m 12s');
  expect(element.querySelector('[role="status"]')?.textContent).toBe(
    'Worked for 1 minutes 12 seconds',
  );
  expect(line?.hasAttribute('data-open')).toBe(false);

  act(() => element.querySelector<HTMLButtonElement>('.thought-head')?.click());
  expect(line?.hasAttribute('data-open')).toBe(true);
});

it('keeps a failed step in the trace with what went wrong', () => {
  act(() =>
    root.render(
      <ThoughtLine
        working={false}
        steps={[{ key: 'x', text: 'Reading a page', status: 'failed', note: 'Failed: 404' }]}
      />,
    ),
  );
  const step = element.querySelector('.thought-trace li');
  expect(step?.getAttribute('data-status')).toBe('failed');
  expect(step?.textContent).toContain('Failed: 404');
});

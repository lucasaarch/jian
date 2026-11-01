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

it('starts folded, settles into the time the work took, and can be opened by hand', () => {
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
  expect(line?.hasAttribute('data-open')).toBe(false);
  expect(element.querySelector('.thought-head')?.getAttribute('aria-expanded')).toBe('false');

  act(() => element.querySelector<HTMLButtonElement>('.thought-head')?.click());
  expect(line?.hasAttribute('data-open')).toBe(true);

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
    '2 tool calls · 1 minutes 12 seconds',
  );
  expect(line?.hasAttribute('data-open')).toBe(true);
});

it('keeps every tool call, its input, and its output folded inside the activity', () => {
  act(() =>
    root.render(
      <ThoughtLine
        working
        steps={[
          {
            key: 'cmd',
            text: 'Running a command',
            status: 'done',
            input: { text: '{"command":"pwd"}' },
            output: { text: '/workspace' },
          },
        ]}
      />,
    ),
  );

  expect(element.querySelector('.thought-head')?.getAttribute('aria-expanded')).toBe('false');
  const call = element.querySelector<HTMLDetailsElement>('.thought-tool');
  expect(call?.open).toBe(false);
  expect(call?.textContent).toContain('{"command":"pwd"}');
  expect(call?.textContent).toContain('/workspace');
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

it('opens full highlighted error details on click instead of exposing a hover tooltip', async () => {
  const message = `The tool could not read the attachment. ${'Diagnostic detail. '.repeat(100)}Final detail.`;
  await act(async () =>
    root.render(
      <ThoughtLine
        working
        steps={[
          {
            key: 'failed',
            text: 'Looking at an attachment',
            status: 'failed',
            note: 'Failed',
            detail: JSON.stringify({ name: 'Error', message }),
          },
        ]}
      />,
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  act(() => element.querySelector<HTMLButtonElement>('.thought-head')?.click());
  act(() => element.querySelector<HTMLElement>('.thought-tool > summary')?.click());
  await act(async () => element.querySelector<HTMLButtonElement>('button.thought-note')?.click());
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain(message);
  expect(dialog?.textContent).toContain('Final detail.');
  expect(dialog?.querySelector('.hljs-string')).not.toBeNull();
  await act(async () => dialog?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click());
});

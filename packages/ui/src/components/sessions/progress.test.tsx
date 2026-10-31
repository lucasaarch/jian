import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Run, ToolStep } from '../../lib/api';
import { LiveTurn } from './progress';

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

const run = (text: string): Run =>
  ({
    id: 'run',
    status: 'running',
    createdAt: '2026-10-31T10:00:00Z',
    progress: {
      phase: text ? 'writing' : 'thinking',
      text,
      steps: 0,
      updatedAt: '2026-10-31T10:00:03Z',
    },
  }) as Run;

it('replaces waiting activity with the answer as the first text arrives', () => {
  act(() => root.render(<LiveTurn run={run('')} steps={[]} />));
  expect(element.querySelector('.work-spinner')).not.toBeNull();
  act(() => root.render(<LiveTurn run={run('The answer is arriving.')} steps={[]} />));
  expect(element.querySelector('.thought-line')).toBeNull();
  expect(element.querySelector('.streaming')?.textContent).toBe('The answer is arriving.');
  const paragraph = element.querySelector('.streaming p');
  const firstWord = element.querySelector('.stream-word');
  act(() => root.render(<LiveTurn run={run('The answer is arriving. More text.')} steps={[]} />));
  expect(element.querySelector('.streaming')?.textContent).toBe(
    'The answer is arriving. More text.',
  );
  expect(element.querySelector('.streaming p')).toBe(paragraph);
  expect(element.querySelector('.stream-word')).toBe(firstWord);
});

it('keeps completed tool history available without a working indicator over the answer', () => {
  const steps = [{ toolCallId: 'read', toolName: 'read_file', status: 'done' }] as ToolStep[];
  act(() => root.render(<LiveTurn run={run('Found the relevant file.')} steps={steps} />));
  expect(element.querySelector('.work-spinner')).toBeNull();
  expect(element.querySelector('.thought-head')?.getAttribute('aria-expanded')).toBe('false');
  act(() => element.querySelector<HTMLButtonElement>('.thought-head')?.click());
  expect(element.querySelector('.thought-trace')?.textContent).toContain('Reading a file');
  expect(element.querySelector('.streaming')?.textContent).toBe('Found the relevant file.');
});

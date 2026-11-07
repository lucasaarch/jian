import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolStep } from '../../lib/api';
import { readOnce, StepDetailsContext } from './step-details';
import { ThoughtLine, type ThoughtStep } from './thought-line';

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

/** A tool the list cut: a preview of what it read. */
const brief: ThoughtStep = {
  key: 'call-1',
  text: 'Reading a file',
  status: 'done',
  brief: true,
  input: { text: '{"path":"notes.md"}' },
  output: { text: 'The first lines of the no', truncated: true },
};

const whole: ToolStep = {
  toolCallId: 'call-1',
  toolName: 'read_file',
  status: 'done',
  startedAt: '2026-11-07T10:00:00.000Z',
  input: '{"path":"notes.md"}',
  output: 'The first lines of the notes, and every line after them.',
};

const draw = (details: ReturnType<typeof readOnce> | undefined, steps = [brief]) =>
  act(() =>
    root.render(
      <StepDetailsContext.Provider value={details}>
        <ThoughtLine working={false} steps={steps} />
      </StepDetailsContext.Provider>,
    ),
  );

const tool = () => element.querySelector<HTMLDetailsElement>('.thought-tool');

/** A browser fires `toggle` when the summary is used; the test DOM does not. */
async function toggle(open: boolean) {
  const details = tool();
  if (!details) throw new Error('No details to toggle');
  await act(async () => {
    details.open = open;
    details.dispatchEvent(new Event('toggle'));
  });
}

const openTrace = () =>
  act(() => element.querySelector<HTMLButtonElement>('.thought-head')?.click());

it('reads a brief tool in full when it is opened, and draws what it read', async () => {
  let answer!: (step: ToolStep) => void;
  const read = vi.fn(
    () =>
      new Promise<ToolStep>((resolve) => {
        answer = resolve;
      }),
  );
  draw(readOnce(read));
  openTrace();
  expect(read).not.toHaveBeenCalled();

  await toggle(true);
  // The preview stays while the rest is on its way, with a quiet word that it is.
  expect(tool()?.textContent).toContain('The first lines of the no');
  expect(element.textContent).toContain('Reading the full details');

  await act(async () => answer(whole));
  expect(read).toHaveBeenCalledWith('call-1');
  expect(tool()?.textContent).toContain('every line after them');
  expect(tool()?.textContent).not.toContain('Output truncated.');
  expect(element.textContent).not.toContain('Reading the full details');
});

it('reads a step once, however often it is opened or the trace drawn again', async () => {
  const read = vi.fn(async () => whole);
  const details = readOnce(read);
  draw(details);
  openTrace();
  await toggle(true);
  await toggle(false);
  await toggle(true);

  // A later brief read of the turn draws the trace again: what was read in full stays.
  act(() => root.unmount());
  root = createRoot(element);
  draw(details, [{ ...brief }]);
  openTrace();
  await toggle(true);

  expect(read).toHaveBeenCalledTimes(1);
  expect(tool()?.textContent).toContain('every line after them');
  expect(element.textContent).not.toContain('Reading the full details');
});

it('keeps the preview when the full step cannot be read, and says so', async () => {
  const read = vi.fn(async (): Promise<ToolStep> => {
    throw new Error('Not found');
  });
  draw(readOnce(read));
  openTrace();
  await toggle(true);

  expect(tool()?.textContent).toContain('The first lines of the no');
  expect(tool()?.textContent).toContain('The full details could not be read.');
});

it('never reads a tool that is whole already, nor without a conversation to read from', async () => {
  const read = vi.fn(async () => whole);
  draw(readOnce(read), [{ ...brief, brief: undefined }]);
  openTrace();
  await toggle(true);
  expect(read).not.toHaveBeenCalled();

  draw(undefined);
  await toggle(false);
  await toggle(true);
  expect(read).not.toHaveBeenCalled();
  expect(tool()?.textContent).toContain('The first lines of the no');
  expect(element.textContent).not.toContain('could not be read');
});

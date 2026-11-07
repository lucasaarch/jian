import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gatewayApi, type ToolStep } from '../../lib/api';
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
  vi.unstubAllGlobals();
});

/** A tool the list cut: a preview of what it read. */
const brief: ThoughtStep = {
  key: 'call-1',
  run: 'run-1',
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
  expect(read).toHaveBeenCalledWith('run-1', 'call-1');
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

it('reads a step by its turn, so a call id another turn used reads as its own', async () => {
  const read = vi.fn(async (run: string) => ({ ...whole, output: `Read in ${run}.` }));
  const details = readOnce(read);
  draw(details, [{ ...brief, run: 'run-2' }]);
  openTrace();
  await toggle(true);

  expect(read).toHaveBeenCalledWith('run-2', 'call-1');
  expect(tool()?.textContent).toContain('Read in run-2.');
  expect(details.known('run-1', 'call-1')).toBeUndefined();
});

it('keeps the preview when the gateway has no such step, as one that predates the route', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'Not Found' }, { status: 404 })),
  );
  const api = gatewayApi();
  draw(readOnce((run, call) => api.toolStep('profile', 'session', run, call)));
  openTrace();
  await toggle(true);
  await vi.waitFor(() =>
    expect(tool()?.querySelector('[role="status"]')?.textContent).toBe(
      'The full details could not be read.',
    ),
  );

  expect(tool()?.textContent).toContain('The first lines of the no');
});

it('reads again when a tool that failed is opened again, and says it is reading meanwhile', async () => {
  let fail = true;
  let answer!: (step: ToolStep) => void;
  const read = vi.fn(async (): Promise<ToolStep> => {
    if (fail) throw new Error('Offline');
    return new Promise<ToolStep>((resolve) => {
      answer = resolve;
    });
  });
  draw(readOnce(read));
  openTrace();
  await toggle(true);
  expect(element.textContent).toContain('could not be read');

  fail = false;
  await toggle(false);
  await toggle(true);
  expect(element.textContent).not.toContain('could not be read');
  expect(element.textContent).toContain('Reading the full details');

  await act(async () => answer(whole));
  expect(read).toHaveBeenCalledTimes(2);
  expect(tool()?.textContent).toContain('every line after them');
});

it('never draws a brief diff empty: it waits for the lines, or says they are not loaded', async () => {
  const diff = {
    path: 'src/deploy.ts',
    additions: 1,
    deletions: 0,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [] }],
  };
  let answer!: (step: ToolStep) => void;
  let fail!: () => void;
  const read = vi.fn(
    () =>
      new Promise<ToolStep>((resolve, reject) => {
        answer = resolve;
        fail = () => reject(new Error('Offline'));
      }),
  );
  draw(readOnce(read), [{ ...brief, diff }]);
  openTrace();
  await toggle(true);
  expect(tool()?.querySelector('.code-diff')).toBeNull();
  expect(element.textContent).toContain('Reading the full details');

  await act(async () => fail());
  expect(tool()?.querySelector('.code-diff')).toBeNull();
  expect(tool()?.textContent).toContain('src/deploy.ts: lines not loaded.');

  await toggle(false);
  await toggle(true);
  const lines = [{ kind: 'add' as const, new: 1, text: 'export const host = "example.test";' }];
  await act(async () =>
    answer({ ...whole, diff: { ...diff, hunks: [{ ...diff.hunks[0], lines }] } as never }),
  );
  expect(tool()?.querySelector('.code-diff')).not.toBeNull();
  expect(tool()?.textContent).not.toContain('lines not loaded');
});

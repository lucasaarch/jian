// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { hasDetails, ToolDetails } from './tool-details';

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

const show = (input?: string, output?: string, truncated = false) =>
  act(async () =>
    root.render(
      <ToolDetails
        {...(input !== undefined ? { input: { text: input, truncated } } : {})}
        {...(output !== undefined ? { output: { text: output, truncated } } : {})}
      />,
    ),
  );

const fields = () =>
  [...element.querySelectorAll('.tool-field')].map((field) => [
    field.querySelector('dt')?.textContent,
    field.querySelector('dd')?.textContent,
  ]);

it('reads an input object as named fields, in the owner’s words', async () => {
  await show(JSON.stringify({ subscription_id: 'sub-1', dry_run: false, retries: 3 }, null, 2));

  expect(fields()).toEqual([
    ['Subscription id', 'sub-1'],
    ['Dry run', 'No'],
    ['Retries', '3'],
  ]);
});

it('gives a long or multi-line value a block of its own, in full', async () => {
  const content = 'first line\nsecond line';

  await show(JSON.stringify({ path: 'notes.md', content }));

  expect(fields()[0]).toEqual(['Path', 'notes.md']);
  expect(element.querySelector('.tool-block')?.textContent).toContain('second line');
  expect(element.textContent).toContain('Content');
});

it('shows a command as a command', async () => {
  await show(JSON.stringify({ command: 'git status --short' }));

  expect(element.querySelector('.tool-block')?.textContent).toContain('git status --short');
});

it('shows nested values whole rather than as an object placeholder', async () => {
  await show(JSON.stringify({ filter: { state: 'open' } }));

  expect(element.textContent).toContain('"state": "open"');
  expect(element.textContent).not.toContain('[object Object]');
});

it('reads the text a tool server answered with, not the envelope around it', async () => {
  await show(
    undefined,
    JSON.stringify({ content: [{ type: 'text', text: 'Three open issues.' }] }),
  );

  expect(element.textContent).toContain('Three open issues.');
  expect(element.textContent).not.toContain('"type"');
});

it('reads a plain answer as text', async () => {
  await show(undefined, 'Done.');

  expect(element.querySelector('.tool-block')?.textContent).toContain('Done.');
});

it('shows what was cut as it is and says it was cut', async () => {
  await show('{"text":"unfinished', undefined, true);

  expect(element.textContent).toContain('{"text":"unfinished');
  expect(element.textContent).toContain('Input truncated.');
});

it('says a tool took no arguments instead of showing an empty object', async () => {
  await show('{}', undefined);

  expect(element.textContent).toContain('No arguments');
});

it('has details only when something was recorded', () => {
  expect(hasDetails({})).toBe(false);
  expect(hasDetails({ output: { text: 'Done.' } })).toBe(true);
  expect(hasDetails({ input: { text: '{}' } })).toBe(true);
  expect(hasDetails({ note: 'Failed' })).toBe(false);
  expect(hasDetails({ note: 'Failed', detail: 'It broke.' })).toBe(true);
});

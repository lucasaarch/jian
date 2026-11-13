import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MultiSelectField } from './select-field';

let element: HTMLDivElement;
let root: Root;
let written: string[][];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  written = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

const options = ['octo-example/site', 'octo-example/docs', 'river-example/api'].map((name) => ({
  value: name,
  label: name,
}));

function Field({ initial }: { initial: string[] }) {
  const [values, setValues] = useState(initial);
  return (
    <MultiSelectField
      label="Repositories"
      values={values}
      options={options}
      onValuesChange={(next) => {
        written.push(next);
        setValues(next);
      }}
    />
  );
}

const chips = () =>
  [...element.querySelectorAll('[aria-label^="Remove "]')].map((button) =>
    button.getAttribute('aria-label')?.slice('Remove '.length),
  );

it('shows what is chosen as chips, and lets each go on its own', async () => {
  await act(async () =>
    root.render(<Field initial={['octo-example/docs', 'river-example/api']} />),
  );
  expect(chips()).toEqual(['octo-example/docs', 'river-example/api']);

  await act(async () =>
    element.querySelector<HTMLButtonElement>('[aria-label="Remove octo-example/docs"]')?.click(),
  );

  expect(written).toEqual([['river-example/api']]);
  expect(chips()).toEqual(['river-example/api']);
});

const shownOptions = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((item) => item.textContent);

it('searches the list from its top, and adds the pick to the others', async () => {
  await act(async () => root.render(<Field initial={['river-example/api']} />));
  await act(async () =>
    element.querySelector<HTMLButtonElement>('button:not([aria-label^="Remove "])')?.click(),
  );
  const search = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search repositories"]',
    );
    if (!input) throw new Error('no search');
    return input;
  });
  await vi.waitFor(() => expect(shownOptions()).toHaveLength(3));

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'site');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await vi.waitFor(() => expect(shownOptions()).toEqual(['octo-example/site']));

  await act(async () => document.querySelector<HTMLElement>('[role="option"]')?.click());

  expect(written.at(-1)?.sort()).toEqual(['octo-example/site', 'river-example/api']);
});

it('counts the choices past the first two instead of growing', async () => {
  await act(async () =>
    root.render(
      <Field initial={['octo-example/site', 'octo-example/docs', 'river-example/api']} />,
    ),
  );
  expect(chips()).toEqual(['octo-example/site', 'octo-example/docs']);
  expect(element.textContent).toContain('+1 more');
});

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

it('adds a choice picked from the list, keeping the others', async () => {
  await act(async () => root.render(<Field initial={['river-example/api']} />));
  const input = element.querySelector<HTMLInputElement>('input');
  await act(async () => {
    input?.focus();
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  const site = await vi.waitFor(() => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === 'octo-example/site',
    );
    if (!option) throw new Error('no option');
    return option;
  });

  await act(async () => site.click());

  expect(written.at(-1)?.sort()).toEqual(['octo-example/site', 'river-example/api']);
});

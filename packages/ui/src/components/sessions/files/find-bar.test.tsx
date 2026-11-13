import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CodeView } from './code-view';
import { FindBar, useFind } from './find-bar';

const text = ['const price = 1;', 'const tax = 2;', 'return Price + tax + PRICE;'];
const lines = text.map((line) => [{ text: line }]);

function Harness() {
  const find = useFind(text);
  return (
    <>
      <button type="button" onClick={find.show}>
        open
      </button>
      {find.open && <FindBar find={find} />}
      <CodeView lines={lines} wrap={false} hits={find.hits} current={find.current} />
    </>
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector('button')?.click());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const field = () => container.querySelector('input') as HTMLInputElement;
const said = () => container.querySelector('[role=status]')?.textContent;
const marks = () => [...container.querySelectorAll('mark')];
/** The line the current match is on, from 1, and its text. */
const current = () => {
  const mark = container.querySelector('mark[data-current]');
  return `${mark?.closest('[data-line]')?.getAttribute('data-line')}:${mark?.textContent}`;
};
const named = (label: string) =>
  container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

async function type(words: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field(), words);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const press = (shiftKey = false) =>
  act(async () => {
    field().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }),
    );
  });

it('takes the keyboard when it opens and marks nothing until words are typed', () => {
  expect(document.activeElement).toBe(field());
  expect(said()).toBe('');
  expect(marks()).toHaveLength(0);
  expect(named('Next match').disabled).toBe(true);
});

it('counts every match whatever its case and starts on the first', async () => {
  await type('price');

  expect(said()).toBe('1 of 3');
  expect(marks().map((mark) => mark.textContent)).toEqual(['price', 'Price', 'PRICE']);
  expect(current()).toBe('1:price');
});

it('goes to the next with Enter and round to the first past the last', async () => {
  await type('price');
  await press();
  expect(said()).toBe('2 of 3');
  expect(current()).toBe('3:Price');

  await press();
  expect(current()).toBe('3:PRICE');
  await press();
  expect(said()).toBe('1 of 3');
  expect(current()).toBe('1:price');
});

it('goes back with Shift+Enter, round to the last before the first', async () => {
  await type('price');
  await press(true);

  expect(said()).toBe('3 of 3');
  expect(current()).toBe('3:PRICE');
});

it('moves with its buttons as with the keys', async () => {
  await type('tax');
  await act(async () => named('Next match').click());
  expect(said()).toBe('2 of 2');
  expect(current()).toBe('3:tax');

  await act(async () => named('Previous match').click());
  expect(said()).toBe('1 of 2');
});

it('starts over on the first match when the words change', async () => {
  await type('price');
  await press();
  await type('tax');

  expect(said()).toBe('1 of 2');
  expect(current()).toBe('2:tax');
});

it('says so when nothing matches, and has nowhere to go', async () => {
  await type('discount');

  expect(said()).toBe('No results');
  expect(marks()).toHaveLength(0);
  expect(named('Next match').disabled).toBe(true);
  expect(named('Previous match').disabled).toBe(true);
});

it('leaves no mark behind once closed', async () => {
  await type('price');
  await act(async () => named('Close find').click());

  expect(container.querySelector('input')).toBeNull();
  expect(marks()).toHaveLength(0);
});

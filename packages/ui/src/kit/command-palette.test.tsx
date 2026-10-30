import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CommandPalette } from './command-palette';

async function palette() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ran: string[] = [];
  const close = vi.fn();
  const commands = ['New chat', 'Check for updates', 'Switch to light theme'].map((title) => ({
    id: title,
    title,
    run: () => ran.push(title),
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<CommandPalette open onOpenChange={close} commands={commands} />),
  );
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Search commands"]');
  if (!input) throw new Error('The palette has no search field.');
  const type = async (value: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const press = async (key: string) =>
    act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  return { ran, close, type, press, options, done: () => act(() => root.unmount()) };
}

it('narrows to what is typed and runs the one chosen with Enter', async () => {
  const view = await palette();
  await view.type('theme');
  expect(view.options()).toEqual(['Switch to light theme']);
  await view.press('Enter');
  expect(view.ran).toEqual(['Switch to light theme']);
  expect(view.close).toHaveBeenCalledWith(false);
  await view.done();
});

it('moves through the list with the arrows', async () => {
  const view = await palette();
  await view.press('ArrowDown');
  await view.press('Enter');
  expect(view.ran).toEqual(['Check for updates']);
  await view.done();
});

import { act, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { type AppCommand, CommandsProvider, useCommands } from './registry';

let unmount: () => Promise<void> = async () => {};
afterEach(() => unmount());

/** A host with one command bound to N, in a browser or in the app; happy-dom is not a Mac. */
async function host(browser: boolean) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const ran: string[] = [];
  function Offer() {
    useCommands(
      'test',
      useMemo<AppCommand[]>(
        () => [{ id: 'new', title: 'New chat', keys: { key: 'n' }, run: () => ran.push('new') }],
        [],
      ),
    );
    return null;
  }
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <CommandsProvider browser={browser}>
        <Offer />
      </CommandsProvider>,
    ),
  );
  unmount = async () => {
    await act(async () => root.unmount());
    element.remove();
  };
  const press = (key: string, shift = false) =>
    act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: shift, cancelable: true }),
      );
    });
  const listed = () =>
    [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  return { ran, press, listed };
}

it('opens with Ctrl+Shift+P and runs a command from its keys', async () => {
  const app = await host(false);
  await app.press('n');
  expect(app.ran).toEqual(['new']);

  await app.press('P', true);
  expect(app.listed()).toEqual(['New chatCtrl+N']);
});

it('leaves the browser the keys it keeps, and still lists their commands', async () => {
  const web = await host(true);
  await web.press('n');
  expect(web.ran).toEqual([]);

  await web.press('P', true);
  expect(web.listed()).toEqual(['New chat']);
});

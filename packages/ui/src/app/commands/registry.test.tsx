import { act, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { KeymapsPage } from '../settings/keymaps-page';
import { type AppCommand, CommandsProvider, useCommands } from './registry';

let unmount: () => Promise<void> = async () => {};
beforeEach(() => localStorage.clear());
afterEach(async () => {
  await unmount();
  localStorage.clear();
});

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
    return <KeymapsPage />;
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
  expect(app.listed()).toEqual(['New chatCtrl+N', 'Command paletteCtrl+Shift+P']);
});

it('leaves the browser the keys it keeps, and still lists their commands', async () => {
  const web = await host(true);
  await web.press('n');
  expect(web.ran).toEqual([]);

  await web.press('P', true);
  expect(web.listed()).toEqual(['New chat', 'Command paletteCtrl+Shift+P']);
});

const button = (name: string) => {
  const found = [...document.querySelectorAll('button')].find(
    (node) => node.getAttribute('aria-label') === name || node.textContent === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
};
const click = (name: string) => act(async () => button(name).click());
const record = (name: string, key: string, shift = false) =>
  act(async () => {
    button(`Shortcut for ${name}`).dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

it('records without executing, persists across remount, clears and restores a shortcut', async () => {
  let app = await host(false);
  await click('Shortcut for New chat');
  await record('New chat', 'y', true);
  expect(app.ran).toEqual([]);
  await app.press('n');
  expect(app.ran).toEqual([]);
  await app.press('y', true);
  expect(app.ran).toEqual(['new']);
  expect(button('Shortcut for New chat').textContent).toBe('Ctrl+Shift+Y');
  await unmount();
  app = await host(false);
  await app.press('y', true);
  expect(app.ran).toEqual(['new']);
  await click('Clear shortcut for New chat');
  await app.press('y', true);
  expect(app.ran).toEqual(['new']);
  expect(button('Shortcut for New chat').textContent).toBe('Unassigned');
  await click('Restore defaults');
  await app.press('n');
  expect(app.ran).toEqual(['new', 'new']);
});

it('refuses conflicts and reserved shortcuts while leaving the existing binding usable', async () => {
  const app = await host(false);
  await click('Shortcut for New chat');
  await record('New chat', 'p', true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    'Already assigned to Command palette',
  );
  expect(app.listed()).toEqual([]);
  await record('New chat', 'v');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('reserved');
  await record('New chat', 'Escape');
  await app.press('n');
  expect(app.ran).toEqual(['new']);
});

it('ignores corrupt saved data and does not advertise a reserved browser override', async () => {
  localStorage.setItem(
    'jian-keymaps',
    JSON.stringify({ new: { key: 't' }, 'command-palette': 'invalid' }),
  );
  const app = await host(true);
  expect(button('Shortcut for New chat').textContent).toBe('Unassigned');
  await app.press('t');
  expect(app.ran).toEqual([]);
  await app.press('p', true);
  expect(app.listed()).toContain('Command paletteCtrl+Shift+P');
});

it('records shifted punctuation using the same physical key when executing', async () => {
  const app = await host(false);
  await click('Shortcut for New chat');
  await act(async () => {
    button('Shortcut for New chat').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '<',
        code: 'Comma',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(button('Shortcut for New chat').textContent).toBe('Ctrl+Shift+,');
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '<',
        code: 'Comma',
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
      }),
    );
  });
  expect(app.ran).toEqual(['new']);
});

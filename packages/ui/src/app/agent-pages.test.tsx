import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { memoryNavigation } from '../platform/navigation';
import { useEscapeTo } from './agent-pages';

let element: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  memoryNavigation.go('/agents/a1/customize/skills');
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

function Page({ back }: { back: string }) {
  useEscapeTo(back);
  return null;
}

const pressEscape = () =>
  act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

it('goes back to the chat open before the page on Escape', async () => {
  await act(async () => root.render(<Page back="/agents/a1/sessions/s-2" />));

  await pressEscape();

  expect(memoryNavigation.current()).toBe('/agents/a1/sessions/s-2');
});

it('leaves Escape to what is open above the page', async () => {
  await act(async () =>
    root.render(
      <>
        <Page back="/agents/a1/sessions/s-2" />
        <div role="dialog" aria-label="Configure" />
      </>,
    ),
  );

  await pressEscape();

  expect(memoryNavigation.current()).toBe('/agents/a1/customize/skills');
});

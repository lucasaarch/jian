import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HoverTip } from './info-tip';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tipShown = () => document.body.textContent?.includes('Close it');
const focus = async () => {
  await act(async () => {
    container.querySelector('button')?.focus();
    await new Promise((done) => setTimeout(done, 20));
  });
};

it('shows under the keyboard’s focus, as a tip normally does', async () => {
  act(() =>
    root.render(
      <HoverTip tip="Close it">
        <button type="button">x</button>
      </HoverTip>,
    ),
  );
  await focus();

  expect(tipShown()).toBe(true);
});

it('stays away from a button that is handed focus on its own, as an opened panel does', async () => {
  act(() =>
    root.render(
      <HoverTip tip="Close it" hoverOnly>
        <button type="button">x</button>
      </HoverTip>,
    ),
  );
  await focus();

  expect(tipShown()).toBe(false);
});

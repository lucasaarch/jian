import { ArrowDown } from 'lucide-react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Action } from './action';

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

it('a busy round button holds only its spinner, and cannot be pressed again', () => {
  act(() =>
    root.render(
      <Action size="icon" aria-label="Go to the latest message" busy>
        <ArrowDown data-testid="arrow" />
      </Action>,
    ),
  );
  const button = container.querySelector('button');

  expect(button?.disabled).toBe(true);
  expect(button?.querySelector('[data-testid="arrow"]')).toBeNull();
  expect(button?.querySelector('.animate-spin')).not.toBeNull();
});

it('a busy button with words keeps them beside its spinner', () => {
  act(() => root.render(<Action busy>Save</Action>));

  expect(container.querySelector('button')?.textContent).toBe('Save');
  expect(container.querySelector('.animate-spin')).not.toBeNull();
});

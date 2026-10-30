import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useVisibleViewport } from './viewport';

function Probe() {
  useVisibleViewport();
  return null;
}

it('follows a keyboard over the screen, and puts back a page it shifted when it goes', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const listeners = new Map<string, () => void>();
  const view = {
    height: 844,
    offsetTop: 0,
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  Object.defineProperty(window, 'visualViewport', { value: view, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
  const scrollTo = vi.fn();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  const root = document.documentElement;
  const element = document.createElement('div');
  document.body.append(element);
  const react = createRoot(element);
  act(() => react.render(<Probe />));

  // The keyboard opens and iOS shifts the visible part to show the field.
  Object.assign(view, { height: 508, offsetTop: 120 });
  Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
  act(() => listeners.get('resize')?.());
  expect(root.hasAttribute('data-keyboard')).toBe(true);
  expect(root.style.getPropertyValue('--viewport-height')).toBe('508px');
  expect(root.style.getPropertyValue('--viewport-top')).toBe('120px');
  expect(scrollTo).not.toHaveBeenCalled();

  // It closes with the page still shifted: the page goes back to the top.
  Object.assign(view, { height: 844, offsetTop: 0 });
  act(() => listeners.get('resize')?.());
  expect(root.hasAttribute('data-keyboard')).toBe(false);
  expect(scrollTo).toHaveBeenCalledWith(0, 0);

  act(() => react.unmount());
  expect(root.style.getPropertyValue('--viewport-height')).toBe('');
});

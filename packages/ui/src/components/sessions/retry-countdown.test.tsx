import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RetryCountdown } from './retry-countdown';

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ now: Date.parse('2026-11-07T12:00:00Z') });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(() => {
  act(() => root.unmount());
  element.remove();
  vi.useRealTimers();
});

const shown = () => element.querySelector('.thought-retry')?.textContent;

it('counts one attempt as one, and a long wait in hours and minutes', () => {
  act(() => root.render(<RetryCountdown attempts={1} nextAt="2026-11-07T15:07:00Z" />));
  expect(shown()).toBe('1 attempt · next in 3h 7m');

  act(() => root.render(<RetryCountdown attempts={41} nextAt="2026-11-07T12:04:30Z" />));
  expect(shown()).toBe('41 attempts · next in 4m 30s');
});

it('says it is trying once the moment has come', () => {
  act(() => root.render(<RetryCountdown attempts={3} nextAt="2026-11-07T12:00:02Z" />));
  act(() => {
    vi.advanceTimersByTime(3_000);
  });
  expect(shown()).toBe('3 attempts · trying now');
});

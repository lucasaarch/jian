import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSmoothText } from './use-smooth-text';

let shown = '';
const Probe = ({ target, active }: { target: string; active: boolean }) => {
  shown = useSmoothText(target, active);
  return null;
};

let frames = 0;
let reduce = false;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  frames = 0;
  reduce = false;
  shown = '';
  vi.stubGlobal('requestAnimationFrame', (run: (now: number) => void) => {
    frames += 1;
    return setTimeout(() => run(performance.now()), 16) as unknown as number;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.stubGlobal('matchMedia', () => ({
    matches: reduce,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = (target: string, active = true) => {
  const root = createRoot(document.createElement('div'));
  const show = (next: string, on = active) =>
    act(() => root.render(<Probe target={next} active={on} />));
  show(target);
  return { show, root };
};
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it('reveals at the base rate', () => {
  const target = 'a'.repeat(400);
  mount(target);
  wait(1040); // 16 ms frames land just under 1 s
  expect(shown.length).toBeGreaterThanOrEqual(80);
  expect(shown.length).toBeLessThanOrEqual(200);
});

it('catches up a large block in about half a second', () => {
  const target = 'word '.repeat(800);
  mount(target);
  wait(600);
  expect(shown).toBe(target);
});

it('keeps what was shown when the text grows', () => {
  const first = 'a'.repeat(300);
  const view = mount(first);
  wait(500);
  const before = shown;
  expect(before.length).toBeGreaterThan(0);
  view.show(`${first}${'b'.repeat(300)}`);
  expect(`${first}${'b'.repeat(300)}`.startsWith(shown)).toBe(true);
  expect(shown.startsWith(before)).toBe(true);
});

it('starts over when the text no longer extends what was shown', () => {
  const view = mount('abc def '.repeat(50));
  wait(300);
  view.show('xyz');
  expect('xyz'.startsWith(shown)).toBe(true);
  wait(1000);
  expect(shown).toBe('xyz');
});

it('shows everything at once when inactive', () => {
  mount('hello world', false);
  expect(shown).toBe('hello world');
  expect(frames).toBe(0);
});

it('shows everything at once under reduced motion', () => {
  reduce = true;
  mount('hello world');
  expect(shown).toBe('hello world');
  expect(frames).toBe(0);
});

it('stops asking for frames once caught up', () => {
  mount('short text here');
  wait(1000);
  const settled = frames;
  wait(1000);
  expect(frames).toBe(settled);
});

it('stops asking for frames after unmount', () => {
  const view = mount('a'.repeat(1000));
  wait(100);
  act(() => view.root.unmount());
  const settled = frames;
  wait(500);
  expect(frames).toBe(settled);
});

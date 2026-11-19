import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PageBody } from './page-layout';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<PageBody label="Things">content</PageBody>));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const page = () => container.querySelector<HTMLElement>('section') as HTMLElement;
const button = () => container.querySelector<HTMLButtonElement>('button') as HTMLButtonElement;
const scrollTo = (top: number) =>
  act(() => {
    page().scrollTop = top;
    page().dispatchEvent(new Event('scroll'));
  });

it('offers the way back to the top only once the page is scrolled past its heading', () => {
  expect(button().getAttribute('aria-label')).toBe('Scroll to top');
  expect(button().hasAttribute('inert')).toBe(true);

  scrollTo(60);
  expect(button().hasAttribute('inert')).toBe(true);

  scrollTo(400);
  expect(button().hasAttribute('inert')).toBe(false);

  scrollTo(0);
  expect(button().hasAttribute('inert')).toBe(true);
});

it('scrolls the page back to the top when pressed', () => {
  const to = vi.fn();
  page().scrollTo = to as unknown as HTMLElement['scrollTo'];
  scrollTo(400);

  act(() => button().click());

  expect(to).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
});

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInspectorAway, useNoInspector, usePageCovering } from '../lib/stores/screen';
import { Page } from './page';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let seen: { away: boolean; covered: boolean };

function Watch() {
  seen = { away: useInspectorAway(), covered: usePageCovering() };
  return null;
}

function List() {
  useNoInspector();
  return null;
}

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

const pressEscape = () =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

it('keeps the Inspector away and the app beneath covered only while it is open', () => {
  const render = (open: boolean) =>
    act(() =>
      root.render(
        <>
          <Watch />
          <Page open={open} onClose={() => undefined} title="Schedules">
            <p>Inside</p>
          </Page>
        </>,
      ),
    );
  render(true);
  expect(container.querySelector('[data-app-page]')?.getAttribute('aria-label')).toBe('Schedules');
  expect(seen).toEqual({ away: true, covered: true });

  render(false);
  expect(container.querySelector('[data-app-page]')).toBeNull();
  expect(seen).toEqual({ away: false, covered: false });
});

it('keeps the Inspector away while another screen still asks it to, after a page closes', () => {
  const render = (open: boolean) =>
    act(() =>
      root.render(
        <>
          <Watch />
          <List />
          <Page open={open} onClose={() => undefined} title="Settings">
            <p>Inside</p>
          </Page>
        </>,
      ),
    );
  render(true);
  render(false);
  expect(seen).toEqual({ away: true, covered: false });
});

it('goes back on Escape, unless a menu of its own takes it', () => {
  const close = vi.fn();
  act(() =>
    root.render(
      <Page open onClose={close} title="Settings">
        <div role="menu" />
      </Page>,
    ),
  );
  pressEscape();
  expect(close).not.toHaveBeenCalled();

  act(() =>
    root.render(
      <Page open onClose={close} title="Settings">
        <p>Inside</p>
      </Page>,
    ),
  );
  pressEscape();
  expect(close).toHaveBeenCalledOnce();
});

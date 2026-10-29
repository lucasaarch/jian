import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VoicePill } from './voice-pill';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let now = 0;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/** jsdom has no PointerEvent; React reads only these fields. */
function pointer(type: string, clientX = 100) {
  const event = new MouseEvent(type, { bubbles: true, clientX, button: 0 });

  return Object.assign(event, { pointerId: 1, isPrimary: true, pointerType: 'mouse' });
}

function render(listening: boolean, onStart = vi.fn(), onStop = vi.fn()) {
  act(() => root.render(<VoicePill listening={listening} onStart={onStart} onStop={onStop} />));

  return { button: container.querySelector('button') as HTMLButtonElement, onStart, onStop };
}

it('a tap latches the recording on, and the next tap stops it, keeping it', () => {
  const { button, onStart } = render(false);

  act(() => button.dispatchEvent(pointer('pointerdown')));
  expect(onStart).toHaveBeenCalledOnce();

  const { onStop } = render(true);
  now = 100;
  act(() => button.dispatchEvent(pointer('pointerup')));
  expect(onStop).not.toHaveBeenCalled();

  now = 2000;
  act(() => button.dispatchEvent(pointer('pointerdown')));
  now = 2100;
  act(() => button.dispatchEvent(pointer('pointerup')));
  expect(onStop).toHaveBeenCalledWith('tap');
});

it('a hold stops on release', () => {
  const { button } = render(false);

  act(() => button.dispatchEvent(pointer('pointerdown')));
  const { onStop } = render(true);
  now = 800;
  act(() => button.dispatchEvent(pointer('pointerup')));

  expect(onStop).toHaveBeenCalledWith('release');
});

it('sliding a held press far enough to the left cancels', () => {
  const { button } = render(false);

  act(() => button.dispatchEvent(pointer('pointerdown', 200)));
  const { onStop } = render(true);
  act(() => button.dispatchEvent(pointer('pointermove', 170)));
  expect(onStop).not.toHaveBeenCalled();
  act(() => button.dispatchEvent(pointer('pointermove', 120)));

  expect(onStop).toHaveBeenCalledWith('cancel');
});

it('Escape stops a recording as discarded, and a keyboard click toggles it', () => {
  const { button, onStart } = render(false);

  act(() => button.click());
  expect(onStart).toHaveBeenCalledOnce();

  const { onStop } = render(true);
  act(() => button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  expect(onStop).toHaveBeenCalledWith('escape');
  expect(button.getAttribute('aria-pressed')).toBe('true');
});

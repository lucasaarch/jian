import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { startRecording } = vi.hoisted(() => ({ startRecording: vi.fn() }));

vi.mock('../../lib/recorder', () => ({
  useRecorder: () => ({ recording: false, seconds: 0, start: startRecording, cancel: vi.fn() }),
}));
vi.mock('../ui', () => ({ AudioPlayer: () => null }));

import { Composer } from './composer';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  startRecording.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('keeps voice-note recording and removes live call controls', async () => {
  await act(async () => {
    root.render(
      createElement(Composer, {
        name: 'Mia',
        upload: vi.fn(),
        send: vi.fn(),
        onSent: vi.fn(),
      }),
    );
  });

  const record = container.querySelector<HTMLButtonElement>('[aria-label="Record a voice note"]');
  expect(record).not.toBeNull();
  expect(container.querySelector('[aria-label="Start voice call"]')).toBeNull();
  expect(container.querySelector('[aria-label="End voice call"]')).toBeNull();

  await act(async () => record?.click());
  expect(startRecording).toHaveBeenCalledOnce();
});

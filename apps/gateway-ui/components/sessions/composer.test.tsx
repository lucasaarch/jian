import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startRecording } = vi.hoisted(() => ({ startRecording: vi.fn() }));

vi.mock('../../lib/recorder', () => ({
  useRecorder: () => ({ recording: false, seconds: 0, start: startRecording, cancel: vi.fn() }),
}));
vi.mock('../ui', () => ({ AudioPlayer: () => null }));

import { Composer } from './composer';

describe('Composer controls', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    startRecording.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers model and effort controls while keeping microphone recording', async () => {
    await act(async () => {
      root.render(
        createElement(Composer, {
          name: 'Mia',
          modelOptions: [],
          providerModels: {},
          saveModel: vi.fn(),
          upload: vi.fn(),
          send: vi.fn(),
          onSent: vi.fn(),
        }),
      );
    });

    expect(container.querySelector('[aria-label="Model for this conversation"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Reasoning effort for this conversation"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Start voice call"]')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Record a voice note"]')?.click();
    });
    expect(startRecording).toHaveBeenCalledOnce();
  });
});

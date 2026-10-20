import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connectLiveVoice } = vi.hoisted(() => ({ connectLiveVoice: vi.fn() }));

vi.mock('./live-voice', () => ({ connectLiveVoice }));
vi.mock('../../lib/recorder', () => ({
  useRecorder: () => ({ recording: false, seconds: 0, start: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('../ui', () => ({ AudioPlayer: () => null }));

import { Composer } from './composer';

describe('voice call hand-off', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    connectLiveVoice.mockReset().mockImplementation(async (_token, _model, onTranscript) => {
      onTranscript('This came from Gemini and must be excluded.', 'assistant');
      onTranscript('Please check the project status.', 'user');
      return { close: vi.fn() };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('sends the original transcript once through the normal message callback on hang-up', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const onSent = vi.fn();

    await act(async () => {
      root.render(
        createElement(Composer, {
          name: 'Mia',
          sessionId: '00000000-0000-4000-8000-000000000001',
          upload: vi.fn(),
          send,
          createVoiceToken: async () => ({
            token: 'short-lived',
            model: 'gemini-live',
            provider: 'google' as const,
          }),
          executeVoiceTool: async () => ({ ok: true }),
          onSent,
        }),
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Start voice call"]')?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="End voice call"]')?.click();
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain(
      '[Voice call · 0:01 · Gemini Live]\nPlease check the project status.',
    );
    expect(send.mock.calls[0]?.[1]).toEqual([]);
    expect(onSent).toHaveBeenCalledTimes(1);
  });
});

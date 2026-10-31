import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { startRecording } = vi.hoisted(() => ({ startRecording: vi.fn() }));

vi.mock('../../lib/recorder', () => ({
  useRecorder: () => ({ recording: false, start: startRecording, cancel: vi.fn() }),
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

it('Return sends from a keyboard, and breaks the line on a touch screen', async () => {
  for (const [coarse, sends] of [
    [false, true],
    [true, false],
  ] as const) {
    const send = vi.fn(async () => undefined);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: coarse && query.includes('coarse'),
    }));
    await act(async () => {
      root.render(
        createElement(Composer, {
          key: String(coarse),
          name: 'Mia',
          upload: vi.fn(),
          send,
          onSent: vi.fn(),
        }),
      );
    });
    const field = container.querySelector('textarea') as HTMLTextAreaElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

    await act(async () => {
      setValue?.call(field, 'Hello');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(send).toHaveBeenCalledTimes(sends ? 1 : 0);
    vi.unstubAllGlobals();
  }
});

it('sends a selected reply reference with the text and clears it only after submission', async () => {
  const send = vi.fn(async () => undefined);
  const cancel = vi.fn();
  await act(async () =>
    root.render(
      <Composer
        name="Nova"
        upload={vi.fn()}
        send={send}
        onSent={vi.fn()}
        replyTo={{ id: 'quoted-message', content: 'The proposal is ready.' }}
        onCancelReply={cancel}
      />,
    ),
  );
  const field = container.querySelector('textarea');
  if (!field) throw new Error('Composer missing');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, 'Please explain.');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click());
  expect(send).toHaveBeenCalledWith('Please explain.', [], 'quoted-message');
  expect(cancel).toHaveBeenCalledOnce();
  expect(container.querySelector('.composer-send .spin')).toBeNull();
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAttached, useDrafts } from '../../lib/stores/drafts';
import { Composer } from './composer';

let element: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  useDrafts.getState().forgetAll();
  useAttached.getState().forgetAll();
});

type Upload = (file: unknown) => Promise<{ id: string }>;

const show = (
  draftKey: string,
  send: (...args: unknown[]) => Promise<unknown> = async () => undefined,
  upload: Upload = vi.fn(),
) =>
  act(async () => {
    root.render(
      <Composer
        key={draftKey}
        draftKey={draftKey}
        name="Mia"
        upload={upload}
        send={send}
        onSent={() => {}}
      />,
    );
  });

const attach = (name: string) =>
  act(async () => {
    const input = element.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.7'], name, { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

const attached = () =>
  [...element.querySelectorAll('.composer-attachments li')].map((item) => item.textContent);

const field = () => element.querySelector('textarea') as HTMLTextAreaElement;

const type = (text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      field(),
      text,
    );
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });

const submit = () =>
  act(async () => {
    element
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

it('keeps what was written for each conversation when the page changes', async () => {
  await show('agent:one');
  await type('Half a thought');
  await show('agent:two');
  expect(field().value).toBe('');
  await type('Another one');

  await show('agent:one');
  expect(field().value).toBe('Half a thought');
  await show('agent:two');
  expect(field().value).toBe('Another one');
});

it('forgets it once sent, and keeps it when sending failed', async () => {
  await show('agent:new', async () => {
    throw new Error('The gateway could not be reached.');
  });
  await type('Ship it');
  await submit();
  expect(useDrafts.getState().texts['agent:new']).toBe('Ship it');
  expect(field().value).toBe('Ship it');

  await act(async () => root.unmount());
  root = createRoot(element);
  await show('agent:new');
  expect(field().value).toBe('Ship it');
  await submit();
  expect(field().value).toBe('');
  expect(useDrafts.getState().texts['agent:new']).toBeUndefined();
});

it('continues lists with Shift+Enter, keeps the draft and caret, then Enter sends', async () => {
  const send = vi.fn(async () => undefined);
  await show('agent:list', send);
  await type('1. First');
  field().setSelectionRange(8, 8);
  await act(async () => {
    field().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(field().value).toBe('1. First\n2. ');
  expect(field().selectionStart).toBe(12);
  expect(useDrafts.getState().texts['agent:list']).toBe('1. First\n2. ');
  expect(send).not.toHaveBeenCalled();
  await act(async () => {
    field().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(field().value).toBe('1. First\n');
  await type('1. First\n2. Second');
  await act(async () => {
    field().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  expect(send).toHaveBeenCalledWith('1. First\n2. Second', []);
});

it('keeps each conversation’s files when the page changes, and sends them from where they were', async () => {
  const send = vi.fn(async () => undefined);
  let finish: (media: { id: string }) => void = () => {};
  const upload = vi.fn<Upload>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await show('agent:one', send, upload);
  await attach('brief.pdf');
  expect(attached()).toEqual([expect.stringContaining('brief.pdf')]);

  // The upload ends while another conversation is open.
  await show('agent:two', send, upload);
  expect(attached()).toEqual([]);
  await act(async () => finish({ id: 'media-brief' }));

  await show('agent:one', send, upload);
  expect(attached()).toEqual([expect.stringContaining('brief.pdf')]);
  await type('See the brief');
  await submit();
  expect(send).toHaveBeenCalledWith('See the brief', ['media-brief']);
  expect(attached()).toEqual([]);

  await show('agent:two', send, upload);
  await show('agent:one', send, upload);
  expect(attached()).toEqual([]);
});

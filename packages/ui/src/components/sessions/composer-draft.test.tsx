import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDrafts } from '../../lib/stores/drafts';
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
});

const show = (draftKey: string, send: () => Promise<unknown> = async () => undefined) =>
  act(async () => {
    root.render(
      <Composer
        key={draftKey}
        draftKey={draftKey}
        name="Mia"
        upload={vi.fn()}
        send={send}
        onSent={() => {}}
      />,
    );
  });

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

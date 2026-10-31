import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type Outgoing, sendNow, useOutbox } from '../../lib/stores/outbox';
import { OutgoingMessage } from './outgoing';

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
  useOutbox.setState({ items: [] });
});

const show = (item: Outgoing) =>
  act(async () =>
    root.render(<OutgoingMessage item={item} profileId="profile" people={new Map()} api={{}} />),
  );

it('draws the message at once without a sending footer', async () => {
  await show({
    key: 'one',
    sessionId: 'session',
    text: 'Ship it',
    mediaIds: [],
    at: '2026-10-30T12:00:00.000Z',
    state: 'sending',
  });

  expect(element.querySelector('.chat-line.mine')?.textContent).toContain('Ship it');
  expect(element.textContent).not.toContain('Sending…');
  expect(element.querySelector('.outgoing-state')).toBeNull();
  expect(element.querySelector('[role="alert"]')).toBeNull();
});

it('says why it was not sent and sends it again from there', async () => {
  let attempts = 0;
  await act(async () => {
    sendNow({
      sessionId: 'session',
      text: 'Ship it',
      mediaIds: [],
      deliver: async () => {
        attempts += 1;
        throw new Error('The gateway could not be reached.');
      },
      delivered: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const [failed] = useOutbox.getState().items;
  if (!failed) throw new Error('Nothing was sent.');
  await show(failed);

  expect(element.querySelector('[role="alert"]')?.textContent).toContain(
    'Not sent: The gateway could not be reached.',
  );
  const retry = [...element.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Retry'),
  );
  await act(async () => {
    retry?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(attempts).toBe(2);
});

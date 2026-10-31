import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '../../lib/api';
import { ChatMessage } from './message';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
const message: Message = {
  id: 'message',
  profileId: 'profile',
  sessionId: 'session',
  role: 'assistant',
  content: 'The proposal is ready.',
  createdAt: '2026-10-31T10:00:00Z',
};
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

it('keeps the chosen reaction in the header, replaces it and removes it by choosing it again', async () => {
  const save = vi.fn(async (_emoji: string | null) => {});
  function Harness() {
    const [current, setCurrent] = useState(message);
    return (
      <ChatMessage
        message={current}
        agent={{ name: 'Nova', avatar: null }}
        people={new Map()}
        group={false}
        opensRun
        onReact={async (emoji) => {
          await save(emoji);
          setCurrent({ ...message, reactions: emoji ? [{ actor: 'owner', emoji }] : [] });
        }}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  await act(async () => button('React to message')?.click());
  await act(async () => button('React ❤️')?.click());
  expect(save).toHaveBeenLastCalledWith('❤️');
  expect(button('React to message')?.textContent).toBe('❤️');
  expect(button('React to message')?.hasAttribute('data-persistent')).toBe(true);
  expect(element.querySelector('.message-reactions')).toBeNull();
  await act(async () => button('React to message')?.click());
  await act(async () => button('React ❤️')?.click());
  expect(save).toHaveBeenLastCalledWith(null);
  expect(button('React to message')?.hasAttribute('data-persistent')).toBe(false);
});

it('releases disabled controls after a failed reaction and allows another attempt', async () => {
  const react = vi
    .fn()
    .mockRejectedValueOnce(new Error('Synthetic connection failure'))
    .mockResolvedValueOnce(undefined);
  await act(async () =>
    root.render(
      <ChatMessage
        message={message}
        agent={{ name: 'Nova', avatar: null }}
        people={new Map()}
        group={false}
        opensRun
        onReact={react}
      />,
    ),
  );
  await act(async () => button('React to message')?.click());
  await act(async () => button('React 👍')?.click());
  expect(button('React 👍')?.disabled).toBe(false);
  await act(async () => button('React 👍')?.click());
  expect(react).toHaveBeenCalledTimes(2);
});

it('anchors agent reactions to the user bubble without adding user header actions', async () => {
  await act(async () =>
    root.render(
      <ChatMessage
        message={{ ...message, role: 'user', reactions: [{ actor: 'agent', emoji: '🎉' }] }}
        agent={{ name: 'Nova', avatar: null }}
        people={new Map()}
        group={false}
        opensRun
      />,
    ),
  );
  expect(element.querySelector('.chat-speaker')).toBeNull();
  expect(element.querySelector('.message-tools')).toBeNull();
  expect(
    element
      .querySelector('.chat-line.mine > .message-reactions [role="img"]')
      ?.getAttribute('aria-label'),
  ).toBe('Nova reacted 🎉');
});

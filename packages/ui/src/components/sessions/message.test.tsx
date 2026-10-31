import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Message } from '../../lib/api';
import { ChatMessage } from './message';

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
});

const media = '0f0e0d0c-0b0a-4908-8706-050403020100';

const show = (content: string) =>
  act(async () =>
    root.render(
      <ChatMessage
        message={
          {
            id: 'm',
            profileId: 'profile',
            sessionId: 'session',
            role: 'user',
            content,
            createdAt: '2026-10-30T12:00:00.000Z',
          } as Message
        }
        group={false}
        people={new Map()}
        opensRun={false}
      >
        <div className="message-media">the voice note</div>
      </ChatMessage>,
    ),
  );

it('leaves out the words a channel writes for a message that is only a file', async () => {
  await show(`[Voice message]\n[Attached media: ${media}]`);

  expect(element.textContent).not.toContain('[Voice message]');
  expect(element.querySelector('.chat-text')).toBeNull();
  expect(element.querySelector('.chat-speaker')).toBeNull();
  expect(element.textContent).toContain('the voice note');
});

it('shows the agent name and avatar on its message', async () => {
  const avatar = 'data:image/png;base64,c3ludGhldGlj';
  await act(async () =>
    root.render(
      <ChatMessage
        message={
          {
            id: 'agent-message',
            profileId: 'profile',
            sessionId: 'session',
            role: 'assistant',
            content: 'Ready.',
            createdAt: '2026-10-31T10:00:00Z',
          } as Message
        }
        agent={{ name: 'Nova', avatar }}
        group={false}
        people={new Map()}
        opensRun
      />,
    ),
  );
  expect(element.querySelector('.chat-speaker')?.textContent).toBe('Nova');
  expect(element.querySelector('.chat-speaker img')?.getAttribute('src')).toBe(avatar);
});

it('keeps what was written beside a file, and the same words when no file came', async () => {
  await show(`Listen to this\n[Attached media: ${media}]`);
  expect(element.querySelector('.chat-text')?.textContent).toBe('Listen to this');

  await show('[Voice message]');
  expect(element.textContent).toContain('[Voice message]');
});

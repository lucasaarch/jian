import { expect, it } from 'vitest';
import type { Contact, Session } from '../../lib/api';
import { choices, conversationName } from './conversations';

it('names a messaging conversation by its contact, or by its stored title, and its app', () => {
  const session = {
    id: 'whatsapp-session',
    channel: 'whatsapp',
    title: 'WhatsApp · 4915550100001',
  } as Session;
  expect(conversationName(session, [], [])).toEqual({
    name: '4915550100001',
    where: 'WhatsApp (Baileys)',
  });
  expect(
    conversationName(session, [{ sessionId: session.id, displayName: 'Maya Chen' } as Contact], []),
  ).toEqual({ name: 'Maya Chen', where: 'WhatsApp (Baileys)' });
  expect(conversationName({ ...session, channel: 'telegram' }, [], []).where).toBe('Telegram');
  expect(conversationName({ ...session, channel: 'api' }, [], []).where).toBe('API Server');
});

it('offers chats, WhatsApp, Telegram and API conversations, in that order and by name', () => {
  const at = (id: string, channel: string, title: string | null) =>
    ({ id, channel, title }) as Session;
  const listed = choices(
    [
      at('api', 'api', 'Billing webhook'),
      at('telegram', 'telegram', 'Telegram · Lee'),
      at('chat-b', 'gateway', 'Release notes'),
      at('whatsapp', 'whatsapp', 'WhatsApp · Maya'),
      at('chat-a', 'gateway', 'deploy'),
      at('chat-new', 'gateway', null),
      at('agent', 'agent', 'Agent · Atlas'),
      at('learning', 'learning', 'Learning'),
    ],
    [],
    [],
  );

  expect(listed.map((choice) => [choice.provider, choice.name])).toEqual([
    ['chats', 'deploy'],
    ['chats', 'New chat'],
    ['chats', 'Release notes'],
    ['whatsapp', 'Maya'],
    ['telegram', 'Lee'],
    ['api', 'Billing webhook'],
  ]);
});

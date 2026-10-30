import { expect, it } from 'vitest';
import type { Contact, Session } from '../../lib/api';
import { choices, conversationName } from './conversations';

it('keeps Meta conversation destinations distinct from API and Baileys', () => {
  const session = {
    id: 'meta-session',
    channel: 'whatsapp-business',
    title: 'WhatsApp Business · 4915550100001',
  } as Session;
  expect(conversationName(session, [], [])).toEqual({
    name: '4915550100001',
    where: 'WhatsApp Business (Meta)',
  });
  expect(
    conversationName(session, [{ sessionId: session.id, displayName: 'Maya Chen' } as Contact], []),
  ).toEqual({ name: 'Maya Chen', where: 'WhatsApp Business (Meta)' });
  expect(conversationName({ ...session, channel: 'whatsapp' }, [], []).where).toBe(
    'WhatsApp (Baileys)',
  );
  expect(conversationName({ ...session, channel: 'telegram' }, [], []).where).toBe('Telegram');
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

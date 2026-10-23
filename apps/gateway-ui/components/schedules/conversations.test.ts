import { expect, it } from 'vitest';
import type { Contact, Session } from '../../lib/api';
import { conversationName } from './conversations';

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

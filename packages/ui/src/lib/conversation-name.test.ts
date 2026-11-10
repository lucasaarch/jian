import { expect, it } from 'vitest';
import type { Contact, Session } from './api';
import { renamedContact } from './conversation-name';

const profileId = 'profile';
const session = (id: string, channel: string) => ({ id, profileId, channel }) as Session;
const contact = (sessionId: string, scope: 'direct' | 'group') =>
  ({ id: `contact-${sessionId}`, profileId, sessionId, scope }) as Contact;

it('renames a person on WhatsApp or Telegram, never a group or an email address', () => {
  const contacts = [
    contact('ada', 'direct'),
    contact('team', 'group'),
    contact('bob', 'direct'),
    contact('mail', 'direct'),
  ];

  expect(renamedContact(session('ada', 'whatsapp'), contacts)?.id).toBe('contact-ada');
  expect(renamedContact(session('bob', 'telegram'), contacts)?.id).toBe('contact-bob');
  expect(renamedContact(session('team', 'whatsapp'), contacts)).toBeUndefined();
  expect(renamedContact(session('mail', 'email'), contacts)).toBeUndefined();
  expect(renamedContact(session('gone', 'whatsapp'), contacts)).toBeUndefined();
});

import type { Contact, Profile, Session } from '../../lib/api';

/**
 * A conversation by the name the Sessions screen gives it — the gateway one, a person or a
 * group by the name they use, another agent by its own, an API conversation by its title —
 * and where it happens.
 */
export function conversationName(
  session: Session,
  contacts: Contact[],
  profiles: Profile[],
): { name: string; where: string } {
  if (session.channel === 'gateway') return { name: 'Gateway', where: 'The panel' };

  const contact = contacts.find((item) => item.sessionId === session.id);
  const peer = profiles.find((item) => item.id === session.peerProfileId);
  const stored = session.title?.replace(/^(Agent|WhatsApp|Telegram)\s·\s/, '');

  if (session.channel === 'whatsapp' || session.channel === 'telegram') {
    const app = session.channel === 'whatsapp' ? 'WhatsApp' : 'Telegram';

    return {
      name: contact?.displayName ?? stored ?? 'Unknown contact',
      where: contact?.scope === 'group' ? `${app} group` : app,
    };
  }

  if (session.channel === 'agent')
    return { name: peer?.name ?? stored ?? 'Agent', where: 'Agents' };

  return { name: session.title ?? 'Untitled conversation', where: 'API Server' };
}

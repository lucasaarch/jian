import type { Contact, Profile, Session } from '../../lib/api';

/** Where a conversation happens, in the order the picker lists them. */
export type Provider = 'chats' | 'whatsapp' | 'telegram' | 'api';

const providers: Array<{ provider: Provider; name: string }> = [
  { provider: 'chats', name: 'Chats' },
  { provider: 'whatsapp', name: 'WhatsApp' },
  { provider: 'telegram', name: 'Telegram' },
  { provider: 'api', name: 'API Server' },
];

/**
 * A conversation by the name the Chats screen gives it — a chat by its title, a person or a
 * group by the name they use, another agent by its own, an API conversation by its title —
 * and where it happens.
 */
export function conversationName(
  session: Session,
  contacts: Contact[],
  profiles: Profile[],
): { name: string; where: string } {
  if (session.channel === 'gateway') return { name: session.title ?? 'New chat', where: 'Chats' };

  const contact = contacts.find((item) => item.sessionId === session.id);
  const peer = profiles.find((item) => item.id === session.peerProfileId);
  const stored = session.title?.replace(
    /^(Agent|WhatsApp(?: Business(?: \(Meta\))?)?|Telegram)\s·\s/,
    '',
  );

  if (['whatsapp', 'whatsapp-business', 'telegram'].includes(session.channel)) {
    const app =
      session.channel === 'whatsapp-business'
        ? 'WhatsApp Business (Meta)'
        : session.channel === 'whatsapp'
          ? 'WhatsApp (Baileys)'
          : 'Telegram';

    return {
      name: contact?.displayName ?? stored ?? 'Unknown contact',
      where: contact?.scope === 'group' ? `${app} group` : app,
    };
  }

  if (session.channel === 'agent')
    return { name: peer?.name ?? stored ?? 'Agent', where: 'Agents' };

  return { name: session.title ?? 'Untitled conversation', where: 'API Server' };
}

/**
 * Where a schedule can run: a chat of the panel, a contact or a group on WhatsApp or Telegram,
 * or an API conversation. Another agent's conversation belongs to that pair of agents.
 */
function providerOf(session: Session): Provider | undefined {
  if (session.channel === 'gateway') return 'chats';
  if (session.channel === 'whatsapp' || session.channel === 'whatsapp-business') return 'whatsapp';
  if (session.channel === 'telegram') return 'telegram';
  if (session.channel === 'api') return 'api';
  return undefined;
}

export type Choice = { session: Session; provider: Provider; name: string; where: string };

/** The conversations a schedule can run in, by provider in the picker's order, then by name. */
export function choices(sessions: Session[], contacts: Contact[], profiles: Profile[]): Choice[] {
  const order = providers.map((item) => item.provider);

  return sessions
    .flatMap((session) => {
      const provider = providerOf(session);
      return provider
        ? [{ session, provider, ...conversationName(session, contacts, profiles) }]
        : [];
    })
    .sort(
      (a, b) =>
        order.indexOf(a.provider) - order.indexOf(b.provider) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
}

import { AGENT_SESSION_CHANNEL, GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import type { Contact, Profile, Project, Session } from './api';

/**
 * What a conversation is called in a list: a chat by the title the agent gave it, a person or
 * group by the name they use, another agent by its own. The stored title of a channel's
 * conversation carries a channel prefix, which a list already says by where it shows it.
 */
export function conversationName(
  session: Session,
  {
    projects,
    contacts,
    profiles,
  }: { projects: Project[]; contacts: Contact[]; profiles: Profile[] },
): string {
  if (session.channel === GATEWAY_SESSION_CHANNEL) {
    const project = projects.find((item) => item.id === session.projectId);
    return session.title ?? (project ? `${project.name} · New chat` : 'New chat');
  }
  const stored = session.title?.replace(/^(Agent|WhatsApp|Telegram)\s·\s/, '');
  if (session.channel === AGENT_SESSION_CHANNEL) {
    return profiles.find((item) => item.id === session.peerProfileId)?.name ?? stored ?? 'Agent';
  }
  if (['whatsapp', 'whatsapp-business', 'telegram'].includes(session.channel)) {
    const contact = contacts.find(
      (item) => item.sessionId === session.id && item.profileId === session.profileId,
    );
    return contact?.displayName ?? stored ?? 'Unknown contact';
  }
  return session.title ?? 'Untitled conversation';
}

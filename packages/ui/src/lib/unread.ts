import { AGENT_SESSION_CHANNEL, GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import type { Session } from './api';

/**
 * A chat of the panel the agent wrote in since the owner last read it. A channel's conversation
 * is read, and marked read, in its own app.
 */
export const unread = (session: Session) =>
  session.channel === GATEWAY_SESSION_CHANNEL &&
  session.lastMessage?.role === 'assistant' &&
  (!session.readAt || Date.parse(session.lastMessage.at) > Date.parse(session.readAt));

const MESSAGING = ['whatsapp', 'whatsapp-business', 'telegram'];

/**
 * Whether a new last message is worth a notice. In a chat of the panel, the agent's reply the
 * owner has not read; their own message never. In a conversation with a person on a messaging
 * app, or with another agent, what either side says, but not the chatter of a group the agent
 * only read. The desktop app's main process tells the same, from its own copy of this rule.
 */
export function worthNotice(session: Session): boolean {
  if (session.channel === GATEWAY_SESSION_CHANNEL) return unread(session);
  if (!MESSAGING.includes(session.channel) && session.channel !== AGENT_SESSION_CHANNEL) {
    return false;
  }
  return !(session.scope === 'group' && session.lastMessage?.role === 'user');
}

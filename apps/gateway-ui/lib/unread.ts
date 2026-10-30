import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import type { Session } from './api';

/**
 * A chat of the panel the agent wrote in since the owner last read it. A channel's conversation
 * is read, and marked read, in its own app.
 */
export const unread = (session: Session) =>
  session.channel === GATEWAY_SESSION_CHANNEL &&
  session.lastMessage?.role === 'assistant' &&
  (!session.readAt || Date.parse(session.lastMessage.at) > Date.parse(session.readAt));

import type { Showing } from '../shared/bridge';

/** Where the window says it is, taken only in the shape the bridge defines. */
export function showingFrom(value: unknown): Showing | null {
  if (!value || typeof value !== 'object') return null;
  const { gatewayId, chat, profileId } = value as {
    gatewayId?: unknown;
    chat?: unknown;
    profileId?: unknown;
  };
  if (typeof gatewayId !== 'string') return null;
  const opened = (chat ?? {}) as { profileId?: unknown; sessionId?: unknown };
  return {
    gatewayId,
    ...(typeof opened.profileId === 'string' && typeof opened.sessionId === 'string'
      ? { chat: { profileId: opened.profileId, sessionId: opened.sessionId } }
      : {}),
    // The agent of a new chat: what its browser's tabs are kept under, until it becomes a chat.
    ...(typeof profileId === 'string' ? { profileId } : {}),
  };
}

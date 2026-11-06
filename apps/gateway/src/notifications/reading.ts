/**
 * A chat read this recently is on the owner's screen: the panel marks an open chat read every
 * half minute. In ms.
 */
export const READING_MS = 60_000;

/** The owner is reading this chat in the panel now, so no device is told about it. */
export function beingRead(session: { readAt?: string }, now: number): boolean {
  return session.readAt !== undefined && now - Date.parse(session.readAt) < READING_MS;
}

import type { Showing } from '../shared/bridge';

/** The window as the main process reads it at the moment something new arrives. */
export type WindowView = { visible: boolean; minimized: boolean; focused: boolean };

/** A conversation on one gateway. */
export type ChatPlace = { gatewayId: string; profileId: string; sessionId: string };

/**
 * Whether the owner is reading this conversation now: the window is up, in front, and open on
 * it. Anything else — hidden in the tray, minimized, behind another app, or on another chat,
 * agent or gateway — is somewhere they are not looking, and what arrives there is announced.
 */
export function looksAt(
  window: WindowView | undefined,
  showing: Showing | null,
  chat: ChatPlace,
): boolean {
  if (!window?.visible || window.minimized || !window.focused) return false;
  return (
    showing?.gatewayId === chat.gatewayId &&
    showing.chat?.profileId === chat.profileId &&
    showing.chat.sessionId === chat.sessionId
  );
}

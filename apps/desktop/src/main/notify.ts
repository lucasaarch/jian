import { Notification } from 'electron';
import type { OpenTarget } from '../shared/bridge';
import type { Notice } from './gateways/monitor';
import type { ChatPlace } from './looking';

const chatKey = (chat: ChatPlace) => `${chat.gatewayId}/${chat.profileId}/${chat.sessionId}`;

/**
 * System notifications for conversations the owner is not looking at. One per chat at a time,
 * as the panel's own notices: a newer one replaces the one still showing, and opening the chat
 * takes its notification away.
 */
export class Notifier {
  private readonly shown = new Map<string, Notification>();
  /** Said once: a system that refuses notifications refuses every one of them alike. */
  private failed = false;

  constructor(private readonly open: (target: OpenTarget) => void) {}

  show(notice: Notice, gatewayName: string, many: boolean): void {
    if (!Notification.isSupported()) return;
    const key = chatKey(notice);
    this.shown.get(key)?.close();
    const notification = new Notification({
      // The same id replaces a delivered one still in the system's list, not only one on screen.
      id: key,
      // With several gateways, the title says which one, since the same agent name may be in two.
      title: many ? `${notice.profileName} · ${gatewayName}` : notice.profileName,
      subtitle: notice.title,
      body: notice.text,
    });
    notification.on('click', () =>
      this.open({
        gatewayId: notice.gatewayId,
        path: `/agents/${notice.profileId}/sessions/${encodeURIComponent(notice.sessionId)}`,
      }),
    );
    notification.on('close', () => {
      if (this.shown.get(key) === notification) this.shown.delete(key);
    });
    // Unheard, a refusal leaves no trace: the owner only sees that nothing ever arrives.
    notification.on('failed', (_event, error) => {
      if (this.failed) return;
      this.failed = true;
      console.error(`A notification could not be shown: ${error}`);
    });
    // Kept until closed: a notification collected by the garbage collector stops hearing clicks.
    this.shown.set(key, notification);
    notification.show();
  }

  /** The owner opened this chat: what told them about it has done its work. */
  dismiss(chat: ChatPlace): void {
    const key = chatKey(chat);
    this.shown.get(key)?.close();
    this.shown.delete(key);
  }

  /** Notifications turned off: none of the ones still showing stays. */
  dismissAll(): void {
    for (const notification of this.shown.values()) notification.close();
    this.shown.clear();
  }
}

import { Notification } from 'electron';
import type { OpenTarget } from '../shared/bridge';
import type { Reply } from './gateways/monitor';

/**
 * A system notification for a reply the owner cannot see: the window is hidden or unfocused, or
 * shows another gateway. One per chat at a time, as the panel's own notices: a newer reply
 * replaces the one still showing.
 */
export class Notifier {
  private readonly shown = new Map<string, Notification>();

  constructor(private readonly open: (target: OpenTarget) => void) {}

  reply(reply: Reply, gatewayName: string, many: boolean): void {
    if (!Notification.isSupported()) return;
    const key = `${reply.gatewayId}/${reply.profileId}/${reply.sessionId}`;
    this.shown.get(key)?.close();
    const notification = new Notification({
      // With several gateways, the title says which one, since the same agent name may be in two.
      title: many ? `${reply.profileName} · ${gatewayName}` : reply.profileName,
      subtitle: reply.title,
      body: reply.text,
    });
    notification.on('click', () =>
      this.open({
        gatewayId: reply.gatewayId,
        path: `/agents/${reply.profileId}/sessions/${encodeURIComponent(reply.sessionId)}`,
      }),
    );
    notification.on('close', () => {
      if (this.shown.get(key) === notification) this.shown.delete(key);
    });
    this.shown.set(key, notification);
    notification.show();
  }
}

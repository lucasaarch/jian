import {
  GATEWAY_SESSION_CHANNEL,
  type PushSubscriptionInput,
  pushSubscriptionInputSchema,
  type Run,
} from '@jian/contracts';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { SessionReader } from '../sessions/port.js';
import type { Store } from '../storage/database.js';
import { pushSubscriptions } from '../storage/schema.js';

/** The installation's own key pair, which push services check every notification against. */
const KEYS = 'web-push-vapid';
/** A notification the browser could not take by then is dropped: it would be news no longer. */
const TTL_SECONDS = 60 * 60;
/** What a notification's text holds at most; a phone shows two lines of it anyway. */
const BODY_CHARS = 180;
/**
 * A chat read this recently is on the owner's screen: the panel marks an open chat read every
 * half minute. Nothing is sent about it, and the browser is never handed a push it should not
 * show — iOS takes the permission back from an app that receives pushes and shows none.
 */
const READING_MS = 60_000;

type Send = typeof webpush.sendNotification;
type Notice = { title: string; body: string; url: string; tag: string };

/**
 * Notifications on the owner's devices, through each browser's own push service, for what the
 * agent says in a chat of the panel. A channel's conversation is read in its own app, which
 * notifies already. The keys are made on first use and kept in the installation's vault.
 */
export class PushNotifications {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly sessions: Pick<SessionReader, 'session'>,
    /** Who sends: push services want a page or an address to reach the sender at. */
    private readonly subject = 'mailto:owner@jian.invalid',
    private readonly send: Send = webpush.sendNotification,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The public half, which a browser needs to subscribe. */
  async publicKey() {
    return { publicKey: (await this.keys()).publicKey };
  }

  async subscribe(input: unknown) {
    const subscription: PushSubscriptionInput = pushSubscriptionInputSchema.parse(input);

    await this.store.db
      .insert(pushSubscriptions)
      .values({
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
      });
    return { endpoint: subscription.endpoint };
  }

  async unsubscribe(input: unknown) {
    const { endpoint } = pushSubscriptionInputSchema.pick({ endpoint: true }).parse(input);

    await this.store.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    return { endpoint };
  }

  /**
   * A run in a chat of the panel came to a stop worth a look: it answered, it asks something,
   * or it failed. One notification per chat at a time: a newer one takes the older's place.
   */
  async runSettled(run: Run) {
    if (run.subagent) return;
    const devices = await this.store.db.select().from(pushSubscriptions);
    if (!devices.length) return;
    const session = await this.sessions.session(run.profileId, run.sessionId);
    if (session.channel !== GATEWAY_SESSION_CHANNEL) return;
    if (session.readAt && this.clock() - Date.parse(session.readAt) < READING_MS) return;

    const said =
      run.status === 'waiting'
        ? run.approval
          ? `Asks to ${run.approval.title}`
          : `Asks: ${run.question?.prompt ?? 'a question'}`
        : run.status === 'completed'
          ? (run.output ?? '')
          : 'Stopped on an error.';
    const body = said.replace(/\s+/g, ' ').trim();

    await this.notify(devices, {
      title: session.title ?? 'New chat',
      body: body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS - 1)}…` : body,
      url: `/agents/${run.profileId}/sessions/${run.sessionId}`,
      tag: run.sessionId,
    });
  }

  private async notify(rows: (typeof pushSubscriptions.$inferSelect)[], notice: Notice) {
    const { publicKey, privateKey } = await this.keys();

    await Promise.all(
      rows.map(async (row) => {
        try {
          await this.send(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            JSON.stringify(notice),
            {
              vapidDetails: { subject: this.subject, publicKey, privateKey },
              TTL: TTL_SECONDS,
              topic: notice.tag.replaceAll('-', '').slice(0, 32),
            },
          );
        } catch (error) {
          // Gone or expired: the browser unsubscribed, or its app was removed.
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await this.store.db
              .delete(pushSubscriptions)
              .where(eq(pushSubscriptions.endpoint, row.endpoint));
          }
        }
      }),
    );
  }

  /** Made once, under the installation's lock, so two workers never make two pairs. */
  private async keys(): Promise<{ publicKey: string; privateKey: string }> {
    const stored = await this.vault.read(KEYS);
    if (stored) return JSON.parse(stored);

    return this.store.transaction('gateway', async (tx) => {
      const raced = await this.vault.read(KEYS, tx);
      if (raced) return JSON.parse(raced);

      const keys = webpush.generateVAPIDKeys();
      await this.vault.put(KEYS, JSON.stringify(keys), tx);
      return keys;
    });
  }
}

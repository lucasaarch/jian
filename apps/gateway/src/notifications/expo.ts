import { GATEWAY_SESSION_CHANNEL, type Run } from '@jian/contracts';
import type { Devices } from '../devices/service.js';
import type { ProfileReader } from '../profiles/port.js';
import type { SessionReader } from '../sessions/port.js';
import { beingRead } from './reading.js';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo refuses a request of more than this many messages. */
const BATCH = 100;
/** Expo prepares receipts about this long after accepting a message; asking sooner finds none. */
const RECEIPT_AFTER_MS = 15 * 60_000;
/** Expo drops receipts after a day, so a ticket not answered by then never will be. */
const RECEIPT_KEPT_MS = 24 * 60 * 60_000;
/** What a notification's text holds at most; a phone shows two lines of it anyway. */
const BODY_CHARS = 180;
/** Waits before the second and third try of a request that failed on the network or a 5xx. */
const RETRY_MS = [1_000, 3_000];
const NOT_REGISTERED = 'DeviceNotRegistered';

export type PushKind = 'reply' | 'approval' | 'question' | 'failed';

type Ticket = { status?: string; id?: string; details?: { error?: string } };
type Receipt = { status?: string; details?: { error?: string } };
type Pending = { id: string; pushToken: string; sentAt: number };

export function pushKind(run: Run): PushKind {
  if (run.status === 'waiting') return run.approval ? 'approval' : 'question';
  return run.status === 'completed' ? 'reply' : 'failed';
}

const cut = (text: string) =>
  text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS - 1)}…` : text;

/**
 * What a phone shows under the agent's name. A phone that asked for no previews gets only the
 * kind of stop, since a lock screen is read by whoever is holding the phone.
 */
export function pushBody(run: Run, previews: boolean): string {
  const kind = pushKind(run);
  if (!previews) {
    return {
      reply: 'replied',
      approval: 'needs your approval',
      question: 'asked you something',
      failed: 'stopped on an error',
    }[kind];
  }
  if (kind === 'approval') return cut(`Asks to ${run.approval?.title ?? 'continue'}`);
  if (kind === 'question') return cut(`Asks: ${run.question?.prompt ?? 'a question'}`);
  if (kind === 'failed') return 'Stopped on an error.';
  // Only the first line: the rest of a long reply is for the chat, not for a banner.
  const first = (run.output ?? '').split('\n').find((line) => line.trim() !== '');
  return first ? cut(first.replace(/\s+/g, ' ').trim()) : 'replied';
}

/**
 * Notifications on the phones the owner paired, through Expo's push service, for what the agent
 * says in a chat of the panel. Expo needs no secret: a device's push token is the address.
 */
export class MobilePush {
  /** Tickets waiting for their receipt. Lost on restart, which only delays forgetting a dead token. */
  private pending: Pending[] = [];

  constructor(
    private readonly devices: Pick<
      Devices,
      'pushTargets' | 'forgetPushToken' | 'waitingConversations'
    >,
    private readonly profiles: ProfileReader,
    private readonly sessions: Pick<SessionReader, 'session'>,
    private readonly fetcher: typeof fetch,
    private readonly clock: () => number = Date.now,
    /** Injected so tests need not wait out the retry delays. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async runSettled(run: Run): Promise<void> {
    if (run.subagent) return;
    const targets = await this.devices.pushTargets();
    if (!targets.length) return;
    const session = await this.sessions.session(run.profileId, run.sessionId);
    if (session.channel !== GATEWAY_SESSION_CHANNEL) return;
    // The owner is reading it in the panel; a phone buzzing about it would be noise.
    if (beingRead(session, this.clock())) return;
    const profile = await this.profiles.profile(run.profileId);
    const kind = pushKind(run);
    const badge = await this.devices.waitingConversations();

    const messages = targets
      // The conversation is open on that phone; a banner about what it is reading is noise.
      .filter((target) => target.focusedSession !== run.sessionId)
      .map((target) => ({
        to: target.pushToken,
        title: profile.name,
        body: pushBody(run, target.previews),
        data: { profileId: run.profileId, sessionId: run.sessionId, runId: run.id, kind },
        categoryId: kind,
        threadId: run.sessionId,
        // On Android a newer push of a chat replaces the older one; iOS groups them by threadId.
        tag: run.sessionId,
        channelId: 'conversations',
        badge,
      }));

    for (let from = 0; from < messages.length; from += BATCH) {
      await this.sendBatch(messages.slice(from, from + BATCH));
    }
  }

  /** Asks Expo what became of the messages it accepted at least 15 minutes ago. */
  async checkReceipts(): Promise<void> {
    const now = this.clock();
    const due = this.pending.filter((item) => now - item.sentAt >= RECEIPT_AFTER_MS);
    if (!due.length) return;
    const answers = await this.post<{ data?: Record<string, Receipt> }>(RECEIPTS_URL, {
      ids: due.map((item) => item.id),
    });
    if (!answers?.data) return;
    const settled = new Set<string>();
    for (const item of due) {
      const receipt = answers.data[item.id];
      if (receipt) {
        settled.add(item.id);
        if (receipt.details?.error === NOT_REGISTERED) {
          await this.devices.forgetPushToken(item.pushToken);
        }
      } else if (now - item.sentAt >= RECEIPT_KEPT_MS) {
        settled.add(item.id);
      }
    }
    this.pending = this.pending.filter((item) => !settled.has(item.id));
  }

  private async sendBatch(messages: Array<{ to: string }>) {
    const answer = await this.post<{ data?: Ticket[] }>(SEND_URL, messages);
    const sentAt = this.clock();
    for (const [index, ticket] of (answer?.data ?? []).entries()) {
      const to = messages[index]?.to;
      if (!to) continue;
      if (ticket.status === 'ok' && ticket.id) {
        this.pending.push({ id: ticket.id, pushToken: to, sentAt });
      } else if (ticket.details?.error === NOT_REGISTERED) {
        await this.devices.forgetPushToken(to);
      }
    }
  }

  /** The parsed answer, or undefined once a request failed for good; never throws. */
  private async post<T>(url: string, body: unknown): Promise<T | undefined> {
    for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
      try {
        const response = await this.fetcher(url, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (response.ok) return (await response.json()) as T;
        // A 4xx would fail the same way again.
        if (response.status < 500) return undefined;
      } catch {
        // A network error is retried like a 5xx.
      }
      const wait = RETRY_MS[attempt];
      if (wait === undefined) break;
      await this.sleep(wait);
    }
    return undefined;
  }
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { whatsappBusinessSetupSchema } from '@jian/contracts';
import { and, asc, eq, isNull, lte, ne, sql } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import type { Vault } from '../security/vault.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  channels,
  contacts,
  metaBindings,
  metaInbox,
  metaReceipts,
  metaWindows,
} from '../storage/schema.js';
import type { IncomingMessage } from './channel.js';
import { findChannel, findContactByIdentity, findDeliveryByRemoteId } from './repository.js';
import { type ChannelRecord, channelSecret } from './service.js';
import {
  metaSignature,
  metaWebhookSchema,
  WhatsAppBusinessChannel,
  windowOpen,
} from './whatsapp-business.js';

export async function metaCanSend(
  db: Queryable,
  channelId: string,
  chatId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ lastInbound: metaWindows.lastInbound })
    .from(metaWindows)
    .innerJoin(channels, eq(channels.id, metaWindows.channelId))
    .innerJoin(metaBindings, eq(metaBindings.channelId, channels.id))
    .innerJoin(
      contacts,
      and(
        eq(contacts.channelId, metaWindows.channelId),
        eq(contacts.chatId, metaWindows.chatId),
        eq(contacts.actorId, metaWindows.chatId),
      ),
    )
    .where(
      and(
        eq(metaWindows.channelId, channelId),
        eq(metaWindows.chatId, chatId),
        ne(contacts.status, 'blocked'),
        eq(contacts.aiEnabled, true),
        eq(channels.enabled, true),
        isNull(channels.revokedAt),
      ),
    )
    .limit(1);
  return windowOpen(row?.lastInbound);
}

/** The window alone is not permission to initiate a conversation. Only signed individual
 * messages persisted by receive() can authorize the delivery created by their intake. */
export async function metaCausalInbound(
  db: Queryable,
  channelId: string,
  chatId: string,
  eventId?: string,
): Promise<boolean> {
  if (!eventId) return false;
  const [row] = await db
    .select({ id: metaInbox.eventId })
    .from(metaInbox)
    .where(
      and(
        eq(metaInbox.channelId, channelId),
        eq(metaInbox.eventId, eventId),
        sql`${metaInbox.payload}->>'kind' = 'message'`,
        sql`${metaInbox.payload}->'message'->>'from' = ${chatId}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

export const metaEventKey = (id: string) => `meta:${createHash('sha256').update(id).digest('hex')}`;

/** Uses the same PostgreSQL store and dispatcher as channel deliveries, not an in-memory webhook queue. */
export class MetaInbox {
  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
    private readonly fetcher: typeof fetch,
    private readonly signal: AbortSignal,
  ) {}

  private async authenticated(channelId: string) {
    const channel = await findChannel(this.store.db, channelId);
    if (!channel || channel.revokedAt || channel.type !== 'whatsapp-business')
      throw new GatewayError(401, 'Unauthorized');
    const stored = await this.vault.read(channel.profileId, channelSecret(channelId));
    if (!stored) throw new GatewayError(401, 'Unauthorized');
    const credential = whatsappBusinessSetupSchema.parse(JSON.parse(stored));
    return { channel, credential };
  }

  async challenge(channelId: string, query: unknown): Promise<string> {
    const { credential } = await this.authenticated(channelId);
    const value = query as Record<string, unknown>;
    const supplied =
      typeof value['hub.verify_token'] === 'string'
        ? Buffer.from(value['hub.verify_token'])
        : Buffer.alloc(0);
    const expected = Buffer.from(credential.verifyToken);
    if (
      value['hub.mode'] !== 'subscribe' ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      typeof value['hub.challenge'] !== 'string' ||
      !/^\d{1,256}$/.test(value['hub.challenge'])
    )
      throw new GatewayError(401, 'Unauthorized');
    return value['hub.challenge'];
  }

  async receive(channelId: string, raw: Buffer, signature: unknown) {
    const { channel, credential } = await this.authenticated(channelId);
    if (channel.whatsappBusinessStatus !== 'configured' || !('appSecret' in credential))
      throw new GatewayError(401, 'Unauthorized');
    if (!metaSignature(raw, signature, credential.appSecret))
      throw new GatewayError(401, 'Unauthorized');
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new GatewayError(400, 'Invalid Meta payload');
    }
    const parsed = metaWebhookSchema.safeParse(payload);
    if (!parsed.success) throw new GatewayError(400, 'Invalid Meta payload');
    const now = Date.now();
    await this.store.transaction(channel.profileId, async (tx) => {
      const current = await findChannel(tx, channelId);
      const [binding] = await tx
        .select()
        .from(metaBindings)
        .where(eq(metaBindings.channelId, channelId))
        .limit(1);
      if (!current || current.revokedAt || !binding) throw new GatewayError(401, 'Unauthorized');
      // Validate the entire batch before acknowledging any of it. An app signature is not a profile authorization.
      for (const entry of parsed.data.entry) {
        if (entry.id !== binding.businessAccountId)
          throw new GatewayError(403, 'Meta account mismatch');
        for (const change of entry.changes) {
          if (change.field !== 'messages') continue;
          if (change.value.metadata?.phone_number_id !== binding.phoneNumberId)
            throw new GatewayError(403, 'Meta phone number mismatch');
          if (change.value.group_id !== undefined) continue;
          for (const message of change.value.messages ?? []) {
            if (
              message.group_id !== undefined ||
              !['text', 'audio'].includes(message.type) ||
              (message.type === 'text' && !message.text?.body.trim()) ||
              (message.type === 'audio' && !message.audio)
            )
              continue;
            const timestamp = Number(message.timestamp) * 1000;
            if (!Number.isSafeInteger(timestamp) || timestamp > now + 300_000) continue;
            const at = new Date(Math.min(timestamp, now));
            const person = await findContactByIdentity(tx, channelId, message.from, message.from);
            const paused = !current.enabled || person?.aiEnabled === false;
            const inserted = await tx
              .insert(metaInbox)
              .values({
                channelId,
                eventId: metaEventKey(message.id),
                ...(paused ? { processedAt: new Date(now) } : {}),
                payload: {
                  kind: 'message',
                  message,
                  name: change.value.contacts?.find((contact) => contact.wa_id === message.from)
                    ?.profile?.name,
                },
              })
              .onConflictDoNothing()
              .returning({ id: metaInbox.eventId });
            // A replay must not reopen an expired window, even when its timestamp was clamped.
            if (inserted.length)
              await tx
                .insert(metaWindows)
                .values({ channelId, chatId: message.from, lastInbound: at })
                .onConflictDoUpdate({
                  target: [metaWindows.channelId, metaWindows.chatId],
                  set: {
                    lastInbound: sql`greatest(${metaWindows.lastInbound}, excluded.last_inbound)`,
                  },
                });
          }
          for (const status of change.value.statuses ?? []) {
            await tx
              .insert(metaInbox)
              .values({
                channelId,
                eventId: metaEventKey(`status:${status.id}:${status.status}:${status.timestamp}`),
                payload: { kind: 'status', status },
              })
              .onConflictDoNothing();
          }
        }
      }
    });
    return { accepted: true };
  }

  async drain(accept: (channel: ChannelRecord, message: IncomingMessage) => Promise<unknown>) {
    for (let index = 0; index < 20; index++) {
      if (this.signal.aborted) return;
      // Select only ready channel heads, so a leased head with a large backlog cannot
      // fill the batch with unclaimable successors and starve unrelated channels.
      const [row] = await this.store.db
        .select()
        .from(metaInbox)
        .where(
          and(
            isNull(metaInbox.processedAt),
            lte(metaInbox.availableAt, new Date()),
            sql`not exists (select 1 from meta_inbox earlier
            where earlier.channel_id = ${metaInbox.channelId}
              and earlier.sequence < ${metaInbox.sequence}
              and earlier.processed_at is null)`,
          ),
        )
        .orderBy(asc(metaInbox.sequence))
        .limit(1);
      if (!row) return;
      const channel = await findChannel(this.store.db, row.channelId);
      if (!channel) continue;
      const identity = and(
        eq(metaInbox.channelId, row.channelId),
        eq(metaInbox.eventId, row.eventId),
      );
      const claimed = await this.store.transaction(channel.profileId, async (tx) => {
        const result = await tx
          .update(metaInbox)
          .set({ availableAt: new Date(Date.now() + 10 * 60_000) })
          .where(
            and(
              identity,
              isNull(metaInbox.processedAt),
              lte(metaInbox.availableAt, new Date()),
              // A lease/retry on the head must stall the channel, not let another worker
              // skip it. Recheck under the profile lock, not just in the initial snapshot.
              sql`not exists (select 1 from meta_inbox earlier
                where earlier.channel_id = ${row.channelId}
                  and earlier.sequence < ${row.sequence}
                  and earlier.processed_at is null)`,
            ),
          )
          .returning();
        return result.length > 0;
      });
      if (!claimed) continue;
      try {
        if (!channel.revokedAt) {
          const payload = row.payload as {
            kind: string;
            message?: unknown;
            name?: string;
            status?: { id: string; status: string; timestamp: string; recipient_id: string };
          };
          if (payload.kind === 'message' && channel.enabled) {
            const adapter = new WhatsAppBusinessChannel();
            const data = adapter.receive(payload.message);
            if (data) {
              const person = await findContactByIdentity(
                this.store.db,
                channel.id,
                data.chatId,
                data.actorId,
              );
              if (person?.aiEnabled === false) {
                await this.store.transaction(channel.profileId, async (tx) => {
                  await tx.update(metaInbox).set({ processedAt: new Date() }).where(identity);
                });
                continue;
              }
              data.requestKey = row.eventId;
              if (payload.name) data.displayName = payload.name;
              const downloaded = await adapter.download(payload.message, {
                channelId: channel.id,
                credential: await this.vault.read(channel.profileId, channelSecret(channel.id)),
                fetch: this.fetcher,
                signal: this.signal,
              });
              if (downloaded.media) data.media = downloaded.media;
              if (downloaded.note) data.text += `\n${downloaded.note}`;
              await accept(channel, data);
            }
          } else if (payload.status) {
            const status = payload.status;
            await this.store.transaction(channel.profileId, async (tx) => {
              const ranks: Record<string, number> = { sent: 1, failed: 2, delivered: 3, read: 4 };
              const delivery = await findDeliveryByRemoteId(tx, channel.id, status.id);
              if (delivery && delivery.chatId !== status.recipient_id) return;
              await tx
                .insert(metaReceipts)
                .values({
                  channelId: channel.id,
                  chatId: status.recipient_id,
                  remoteId: status.id,
                  status: status.status,
                  rank: ranks[status.status] ?? 0,
                  at: new Date(Number(status.timestamp) * 1000),
                })
                .onConflictDoUpdate({
                  target: [metaReceipts.channelId, metaReceipts.remoteId],
                  set: {
                    status: status.status,
                    rank: ranks[status.status] ?? 0,
                    at: new Date(Number(status.timestamp) * 1000),
                  },
                  setWhere: sql`${metaReceipts.rank} < ${ranks[status.status] ?? 0}`,
                })
                .returning();
            });
          }
        }
        await this.store.transaction(channel.profileId, async (tx) => {
          await tx.update(metaInbox).set({ processedAt: new Date() }).where(identity);
        });
      } catch {
        // The durable lease expires after a worker crash or transient failure. Request keys make submission idempotent.
      }
    }
  }
}

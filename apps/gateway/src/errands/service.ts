import { randomUUID } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { ContactRecord } from '../channels/contacts.js';
import { insertDelivery, toContact } from '../channels/repository.js';
import { findConnection } from '../channels/whatsapp/repository.js';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { stableUuid } from '../core/ids.js';
import { insertMessage } from '../sessions/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import { channels, contacts, errands } from '../storage/schema.js';

/**
 * How long a question stays open. Past it, a message from that contact is a new conversation
 * rather than a late answer — mistaking the two is worse than losing a slow reply.
 */
export const ERRAND_WINDOW_MS = 48 * 60 * 60 * 1000;

export type Errand = typeof errands.$inferSelect;

export class Errands {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock = Date.now,
  ) {}

  /**
   * Writes the message to a contact and, when a reply is expected, the row that will carry it
   * back. Both land in one transaction: a question nobody is waiting on, or a wait with no
   * question sent, are each worse than neither.
   */
  async ask(
    profileId: string,
    contactId: string,
    fromSessionId: string,
    runId: string,
    text: string,
    expectReply: boolean,
  ): Promise<{ to: string; errandId?: string }> {
    const contact = await this.contact(profileId, contactId);

    if (contact.status !== 'approved') {
      throw new GatewayError(409, 'That contact is not approved');
    }

    if (contact.scope !== 'direct') {
      throw new GatewayError(409, 'Write in the room itself rather than to a group contact');
    }

    return this.store.transaction(profileId, async (tx) => {
      await this.deliver(tx, profileId, contact, runId, text, randomUUID());

      const errand = expectReply
        ? await this.open(tx, profileId, contact, fromSessionId, text)
        : undefined;

      return {
        to: contact.displayName ?? contact.actorId,
        ...(errand ? { errandId: errand.id } : {}),
      };
    });
  }

  /**
   * Writes into a channel conversation from anywhere: a direct chat or an approved room. The
   * agent names the conversation by its session, the way it finds it among its own; the id is
   * derived from the request key, so a repeated call sends once.
   */
  async write(
    profileId: string,
    sessionId: string,
    runId: string,
    text: string,
    requestKey: string,
  ): Promise<{ to: string; channel: string; sessionId: string } | undefined> {
    const [row] = await this.store.db
      .select({ contact: contacts, channel: channels.type })
      .from(contacts)
      .innerJoin(channels, eq(channels.id, contacts.channelId))
      .where(
        and(
          eq(contacts.profileId, profileId),
          eq(contacts.sessionId, sessionId),
          isNull(channels.revokedAt),
        ),
      )
      .limit(1);

    if (!row) {
      return undefined;
    }

    const contact = toContact(row.contact, row.channel);

    if (contact.status !== 'approved') {
      throw new GatewayError(409, 'That conversation is not approved');
    }

    await this.store.transaction(profileId, (tx) =>
      this.deliver(
        tx,
        profileId,
        contact,
        runId,
        text,
        stableUuid(`write:${profileId}:${sessionId}:${requestKey}`),
      ),
    );

    return { to: contact.displayName ?? contact.actorId, channel: row.channel, sessionId };
  }

  /**
   * Queues the message on the contact's channel and records it in their conversation, where it
   * belongs even when another conversation produced it: without the record the agent writes to
   * someone and their own history shows nothing, which reads as the message never sent.
   */
  private async deliver(
    tx: Queryable,
    profileId: string,
    contact: ContactRecord,
    runId: string,
    text: string,
    id: string,
  ) {
    const connection = await findConnection(tx, contact.channelId);
    const now = new Date(this.clock()).toISOString();

    await insertDelivery(tx, {
      id,
      profileId,
      channelId: contact.channelId,
      chatId: contact.chatId,
      notice: text,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      remoteMessageIds: [],
      saidCount: 0,
      ...(connection ? { connectionGeneration: connection.generation } : {}),
    });

    if (contact.sessionId) {
      await insertMessage(
        tx,
        {
          id,
          profileId,
          sessionId: contact.sessionId,
          runId,
          role: 'assistant',
          content: text,
          createdAt: now,
        },
        true,
      );
    }
  }

  /** Records that this session is waiting on this contact. The message itself is a delivery. */
  async open(
    tx: Queryable,
    profileId: string,
    contact: ContactRecord,
    fromSessionId: string,
    question: string,
  ): Promise<Errand> {
    const now = this.clock();

    const [row] = await tx
      .insert(errands)
      .values({
        id: randomUUID(),
        profileId,
        contactId: contact.id,
        fromSessionId,
        question,
        status: 'waiting',
        expiresAt: new Date(now + ERRAND_WINDOW_MS),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      throw new GatewayError(409, 'That contact already has an unanswered question');
    }

    return row;
  }

  /**
   * Closes the open question this message answers, if there is one. Returns it so the caller
   * can route the reply to the conversation that asked instead of to the contact's own.
   */
  async answer(
    tx: Queryable,
    contactId: string,
    text: string,
    requestKey?: string,
  ): Promise<Errand | null> {
    if (requestKey) {
      const [previous] = await tx
        .select()
        .from(errands)
        .where(
          and(
            eq(errands.contactId, contactId),
            eq(errands.answerRequestKey, requestKey),
            eq(errands.status, 'answered'),
          ),
        )
        .limit(1);
      if (previous) return previous;
    }
    const [open] = await tx
      .select()
      .from(errands)
      .where(
        and(
          eq(errands.contactId, contactId),
          eq(errands.status, 'waiting'),
          gt(errands.expiresAt, new Date(this.clock())),
        ),
      )
      .limit(1);

    if (!open) {
      await this.expire(tx, contactId);

      return null;
    }

    const [closed] = await tx
      .update(errands)
      .set({
        status: 'answered',
        answer: text,
        answerRequestKey: requestKey,
        updatedAt: new Date(this.clock()),
      })
      .where(and(eq(errands.id, open.id), eq(errands.status, 'waiting')))
      .returning();

    return closed ?? null;
  }

  /** A question nobody answered in time stops holding the contact's one open slot. */
  private async expire(tx: Queryable, contactId: string): Promise<void> {
    await tx
      .update(errands)
      .set({ status: 'expired', updatedAt: new Date(this.clock()) })
      .where(and(eq(errands.contactId, contactId), eq(errands.status, 'waiting')));
  }

  /** Who this profile may write to, and who it is already waiting on. */
  async reachable(profileId: string) {
    const rows = await this.store.db
      .select({ contact: contacts, channel: channels.type, open: errands.id })
      .from(contacts)
      .innerJoin(channels, eq(channels.id, contacts.channelId))
      .leftJoin(errands, and(eq(errands.contactId, contacts.id), eq(errands.status, 'waiting')))
      .where(
        and(
          eq(contacts.profileId, profileId),
          eq(contacts.status, 'approved'),
          eq(contacts.scope, 'direct'),
          isNull(channels.revokedAt),
        ),
      )
      .limit(100);

    return rows.map((row) => ({
      id: row.contact.id,
      name: row.contact.title ?? row.contact.actorId,
      channel: row.channel,
      waitingOnThem: row.open !== null,
    }));
  }

  async waiting(profileId: string): Promise<Errand[]> {
    return this.store.db
      .select()
      .from(errands)
      .where(and(eq(errands.profileId, profileId), eq(errands.status, 'waiting')))
      .limit(50);
  }

  async contact(profileId: string, contactId: string): Promise<ContactRecord> {
    const [row] = await this.store.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.profileId, profileId)))
      .limit(1);

    return assertFound(row as ContactRecord | undefined, 'Contact');
  }
}

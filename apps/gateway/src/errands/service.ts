import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm';
import type { ContactRecord } from '../channels/contacts.js';
import { type EmailSearch, searchEmail } from '../channels/email/log.js';
import { openSignupWindow, signupDomain } from '../channels/email/signups.js';
import { bareAddress, oneLine } from '../channels/email/text.js';
import { findEmailThread } from '../channels/email/threads.js';
import {
  findContact,
  findContactByIdentity,
  insertContact,
  insertDelivery,
  toContact,
} from '../channels/repository.js';
import { findConnection } from '../channels/whatsapp/repository.js';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { stableUuid } from '../core/ids.js';
import { insertMessage } from '../sessions/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import { channels, contacts, emailBindings, errands } from '../storage/schema.js';

/**
 * How long a question stays open. Past it, a message from that contact is a new conversation
 * rather than a late answer — mistaking the two is worse than losing a slow reply.
 */
const ERRAND_WINDOW_MS = 48 * 60 * 60 * 1000;
/**
 * Email answers slower: a support desk acknowledges at once and a person replies days later.
 * Counted from the agent's latest email to that address, and every reply in it comes back.
 */
export const EMAIL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const windowOf = (contact: Pick<ContactRecord, 'type'>) =>
  contact.type === 'email' ? EMAIL_WINDOW_MS : ERRAND_WINDOW_MS;

export type EmailRequest = { to: string; subject?: string; text: string; expectReply: boolean };

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
      sourceRunId: runId,
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

  /**
   * Records that this session is waiting on this contact. The message itself is a delivery. An
   * email written again from the same conversation is the same wait, counted from the new one.
   */
  async open(
    tx: Queryable,
    profileId: string,
    contact: ContactRecord,
    fromSessionId: string,
    question: string,
  ): Promise<Errand> {
    const now = this.clock();
    const expiresAt = new Date(now + windowOf(contact));

    if (contact.type === 'email') {
      const [extended] = await tx
        .update(errands)
        .set({ question, expiresAt, updatedAt: new Date(now) })
        .where(
          and(
            eq(errands.contactId, contact.id),
            eq(errands.fromSessionId, fromSessionId),
            eq(errands.status, 'waiting'),
            gt(errands.expiresAt, new Date(now)),
          ),
        )
        .returning();
      if (extended) return extended;
    }

    // A wait whose time is up no longer holds the contact's one open slot.
    await tx
      .update(errands)
      .set({ status: 'expired', updatedAt: new Date(now) })
      .where(
        and(
          eq(errands.contactId, contact.id),
          eq(errands.status, 'waiting'),
          lte(errands.expiresAt, new Date(now)),
        ),
      );

    const [row] = await tx
      .insert(errands)
      .values({
        id: randomUUID(),
        profileId,
        contactId: contact.id,
        fromSessionId,
        question,
        status: 'waiting',
        expiresAt,
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

  /** The wait still open on this contact, if its time is not up. */
  async openFor(tx: Queryable, contactId: string): Promise<Errand | undefined> {
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
    return open;
  }

  /**
   * Closes the open question this message answers, if there is one. Returns it so the caller
   * can route the reply to the conversation that asked instead of to the contact's own. With
   * `keepOpen` (email) the wait stays open until its time is up: a desk's acknowledgement, then a
   * person, then a follow-up all belong to the conversation that wrote.
   */
  async answer(
    tx: Queryable,
    contactId: string,
    text: string,
    requestKey?: string,
    keepOpen = false,
  ): Promise<Errand | null> {
    if (keepOpen) {
      const open = await this.openFor(tx, contactId);
      if (!open) {
        await this.expire(tx, contactId);
        return null;
      }
      const [kept] = await tx
        .update(errands)
        .set({ answer: text, answerRequestKey: requestKey, updatedAt: new Date(this.clock()) })
        .where(eq(errands.id, open.id))
        .returning();
      return kept ?? open;
    }
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

  /** The profile's live email channel and its own address, when it has one. */
  async mailbox(
    profileId: string,
    db: Queryable = this.store.db,
  ): Promise<{ channelId: string; address: string } | undefined> {
    const [row] = await db
      .select({ channelId: channels.id, address: emailBindings.address })
      .from(channels)
      .innerJoin(emailBindings, eq(emailBindings.channelId, channels.id))
      .where(
        and(
          eq(channels.profileId, profileId),
          eq(channels.type, 'email'),
          eq(channels.enabled, true),
          isNull(channels.revokedAt),
        ),
      )
      .orderBy(asc(channels.createdAt))
      .limit(1);
    return row;
  }

  /**
   * Whether an email to this address waits for the owner whatever the conversation's
   * protection. Writing to someone new is how an agent is turned against its owner, so the owner
   * reads the first email before it leaves. After that the agent carries the exchange alone, as
   * the owner chose: an approved contact, or an address this same conversation is still waiting
   * on (`openFor`, 7 days from its latest email), takes no approval. Another conversation, a
   * subagent's included, or a wait that ran out asks again.
   */
  async needsOwner(profileId: string, sessionId: string, to: string): Promise<boolean> {
    const address = bareAddress(to);
    const mailbox = await this.mailbox(profileId);
    if (!address || !mailbox) return true;
    const contact = await findContactByIdentity(this.store.db, mailbox.channelId, address, address);
    if (!contact || contact.status === 'blocked') return true;
    if (contact.status === 'approved') return false;
    const open = await this.openFor(this.store.db, contact.id);
    return open?.fromSessionId !== sessionId;
  }

  /**
   * An email from this conversation to any address. One that is no contact becomes a pending
   * one: the owner approved this email, not the person, so their mail starts nothing on its own
   * and reaches only the conversation that wrote, while it waits. The delivery id comes from the
   * run and the request key, so a repeated call sends once.
   */
  async email(
    profileId: string,
    fromSessionId: string,
    runId: string,
    request: EmailRequest,
    requestKey: string,
  ): Promise<{ to: string; contact: 'approved' | 'pending'; waitingUntil?: string }> {
    const mailbox = await this.mailbox(profileId);
    if (!mailbox) throw new GatewayError(409, 'This agent has no email channel');
    const address = bareAddress(request.to);
    if (!address || address.length > 100)
      throw new GatewayError(400, 'That is not an email address');
    if (address === mailbox.address)
      throw new GatewayError(409, "That is this agent's own address");
    const subject = request.subject ? oneLine(request.subject) : undefined;

    return this.store.transaction(profileId, async (tx) => {
      const contact = await this.mailContact(tx, profileId, mailbox.channelId, address);
      if (contact.status === 'blocked')
        throw new GatewayError(409, 'The owner blocked that address');
      if (!subject && !(await findEmailThread(tx, mailbox.channelId, address))) {
        throw new GatewayError(400, 'Give a subject: nothing was written to that address yet');
      }

      await this.deliver(
        tx,
        profileId,
        contact,
        runId,
        // A first line naming the subject starts a new thread; without one the email continues
        // the latest thread with that address (`envelope`).
        subject ? `Subject: ${subject}\n\n${request.text}` : request.text,
        stableUuid(`email:${profileId}:${runId}:${requestKey}`),
      );

      const errand = request.expectReply
        ? await this.open(tx, profileId, contact, fromSessionId, request.text)
        : undefined;

      return {
        to: address,
        contact: contact.status === 'approved' ? 'approved' : 'pending',
        ...(errand ? { waitingUntil: errand.expiresAt.toISOString() } : {}),
      };
    });
  }

  /**
   * Opens this conversation's wait for a service's mail (`expect_email`): for 30 minutes, mail
   * signed by that domain or a subdomain reaches here as text from outside, a contact or not.
   * No owner approval: it sends nothing, and what it lets in only this conversation reads.
   */
  async expect(profileId: string, sessionId: string, domain: string, reason: string) {
    const mailbox = await this.mailbox(profileId);
    if (!mailbox) throw new GatewayError(409, 'This agent has no email channel');
    const named = signupDomain(domain);
    if (!named) throw new GatewayError(400, 'That is not a domain, such as example.com');
    const window = await this.store.transaction(profileId, (tx) =>
      openSignupWindow(
        tx,
        {
          profileId,
          channelId: mailbox.channelId,
          sessionId,
          domain: named,
          reason: oneLine(reason),
        },
        this.clock(),
      ),
    );
    return {
      address: mailbox.address,
      domain: named,
      waitingUntil: assertFound(window ?? null, 'Window').expiresAt.toISOString(),
    };
  }

  /** The mail this profile received and sent, newest first (`search_email`). */
  async searchEmail(profileId: string, search: EmailSearch) {
    return searchEmail(this.store.db, profileId, search);
  }

  /** The contact an address is, or a new pending one: the owner approved an email, not them. */
  private async mailContact(
    tx: Queryable,
    profileId: string,
    channelId: string,
    address: string,
  ): Promise<ContactRecord> {
    const existing = await findContactByIdentity(tx, channelId, address, address);
    if (existing) return existing;
    const now = new Date(this.clock()).toISOString();
    const contact: ContactRecord = {
      id: randomUUID(),
      profileId,
      channelId,
      type: 'email',
      scope: 'direct',
      actorId: address,
      chatId: address,
      status: 'pending',
      aiEnabled: true,
      canApprove: false,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await insertContact(tx, contact);
    if (!inserted) {
      return assertFound(await findContactByIdentity(tx, channelId, address, address), 'Contact');
    }
    // The panel lists it among the requests, where the owner may approve it as anyone else.
    await recordEvent(tx, this.clock, profileId, 'contact.requested', contact);
    return inserted;
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
    // With its channel's type, which decides how long a question to it stays open.
    const contact = await findContact(this.store.db, contactId);

    return assertFound(contact?.profileId === profileId ? contact : null, 'Contact');
  }
}

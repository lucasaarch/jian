import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm';
import type { ContactRecord, Contacts } from '../channels/contacts.js';
import { type EmailSearch, searchEmail } from '../channels/email/log.js';
import { expectDomain, freeMail, signupDomain } from '../channels/email/signups.js';
import { bareAddress, oneLine } from '../channels/email/text.js';
import { findEmailThread } from '../channels/email/threads.js';
import {
  findContact,
  findContactByIdentity,
  insertDelivery,
  toContact,
} from '../channels/repository.js';
import { findConnection } from '../channels/whatsapp/repository.js';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
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
 * `brief` is what the agent is getting done by writing, for whom, and what the owner wants to
 * hear of it: kept in the address's own conversation, where its replies are answered.
 */
export type EmailRequest = { to: string; subject?: string; text: string; brief: string };

export type Errand = typeof errands.$inferSelect;

export class Errands {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock = Date.now,
    // Only `email` needs it: an address written to becomes a contact with its own conversation.
    private readonly people?: Contacts,
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
   * someone and their own history shows nothing, which reads as the message never sent. A
   * `note` goes before it in that history only, never to the person.
   */
  private async deliver(
    tx: Queryable,
    profileId: string,
    contact: ContactRecord,
    runId: string,
    text: string,
    id: string,
    note?: string,
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
          content: note ? `${note}\n\n${text}` : text,
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
    const expiresAt = new Date(now + ERRAND_WINDOW_MS);

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
   * reads the first email before it leaves. After that the address is the agent's correspondent,
   * an approved contact, and the agent carries the exchange alone from any conversation.
   */
  async needsOwner(profileId: string, to: string): Promise<boolean> {
    const address = bareAddress(to);
    const mailbox = await this.mailbox(profileId);
    if (!address || !mailbox) return true;
    const contact = await findContactByIdentity(this.store.db, mailbox.channelId, address, address);
    return contact?.status !== 'approved';
  }

  /**
   * An email from this conversation to any address. The address becomes an approved contact
   * with an email conversation of its own, which keeps the brief and the email: its replies are
   * turns there, not here. The delivery id comes from the run and the request key, so a repeated
   * call sends once.
   */
  async email(
    profileId: string,
    fromSessionId: string,
    runId: string,
    request: EmailRequest,
    requestKey: string,
  ): Promise<{ to: string; sessionId: string; note: string }> {
    const mailbox = await this.mailbox(profileId);
    if (!mailbox) throw new GatewayError(409, 'This agent has no email channel');
    const people = assertFound(this.people ?? null, 'Contacts');
    const address = bareAddress(request.to);
    if (!address || address.length > 100)
      throw new GatewayError(400, 'That is not an email address');
    if (address === mailbox.address)
      throw new GatewayError(409, "That is this agent's own address");
    const subject = request.subject ? oneLine(request.subject) : undefined;

    return this.store.transaction(profileId, async (tx) => {
      const known = await findContactByIdentity(tx, mailbox.channelId, address, address);
      if (known?.status === 'blocked')
        throw new GatewayError(409, 'The owner blocked that address');
      if (!subject && !(await findEmailThread(tx, mailbox.channelId, address))) {
        throw new GatewayError(400, 'Give a subject: nothing was written to that address yet');
      }
      const contact = await people.correspondent(tx, profileId, mailbox.channelId, address);
      const sessionId = assertFound(contact.sessionId ?? null, 'Session');

      await this.deliver(
        tx,
        profileId,
        contact,
        runId,
        // A first line naming the subject starts a new thread; without one the email continues
        // the latest thread with that address (`envelope`).
        subject ? `Subject: ${subject}\n\n${request.text}` : request.text,
        stableUuid(`email:${profileId}:${runId}:${requestKey}`),
        // Read by the turns its replies start here: why it was written, and what to report.
        `[Your note, from conversation ${fromSessionId}, as you sent the email below: ${oneLine(request.brief)}]`,
      );

      return {
        to: address,
        sessionId,
        note: 'Their replies start turns in that email conversation, not this one: you answer them there and tell the owner only what matters. Read it with read_session.',
      };
    });
  }

  /**
   * Expects mail from a service's domain for 30 days (`expect_email`): mail signed by it or a
   * subdomain is taken in and logged, a machine's kept in that domain's email conversation with
   * no turn, a person's as a correspondent's. No owner approval: it sends nothing. Never for a
   * mailbox provider, where anyone can have an address.
   */
  async expect(profileId: string, domain: string, reason: string) {
    const mailbox = await this.mailbox(profileId);
    if (!mailbox) throw new GatewayError(409, 'This agent has no email channel');
    const named = signupDomain(domain);
    if (!named) throw new GatewayError(400, 'That is not a domain, such as example.com');
    if (freeMail(named))
      throw new GatewayError(
        400,
        'That is a mailbox provider anyone can have an address at: give the service’s own domain',
      );
    const expected = await this.store.transaction(profileId, (tx) =>
      expectDomain(
        tx,
        { profileId, channelId: mailbox.channelId, domain: named, reason: oneLine(reason) },
        this.clock(),
      ),
    );
    return {
      address: mailbox.address,
      domain: named,
      expectedUntil: assertFound(expected ?? null, 'Domain').expiresAt.toISOString(),
      note: `Mail from ${named} is in search_email as soon as it arrives: look there for a code or a link. Automatic mail from it starts nothing; a person writing from it gets an email conversation of their own.`,
    };
  }

  /** The mail this profile received and sent, newest first (`search_email`). */
  async searchEmail(profileId: string, search: EmailSearch) {
    return searchEmail(this.store.db, profileId, search);
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
    // With its channel's type, which the agent is told as where it reaches them.
    const contact = await findContact(this.store.db, contactId);

    return assertFound(contact?.profileId === profileId ? contact : null, 'Contact');
  }
}

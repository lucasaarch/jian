import { randomUUID } from 'node:crypto';
import type { contactSchema } from '@jian/contracts';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { stableUuid } from '../core/ids.js';
import type { ProfileReader } from '../profiles/port.js';
import type { SessionWriter } from '../sessions/port.js';
import { insertMessage, renameSession } from '../sessions/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import { mediaAssets } from '../storage/schema.js';
import { API_SESSION_START } from './api-conversation.js';
import type { ChannelType, IncomingMessage } from './channel.js';
import { isChatChannel } from './kinds.js';
import {
  findChannel,
  findContact,
  findContactByIdentity,
  insertContact,
  listContacts,
  updateContact,
} from './repository.js';

/**
 * `requestKey` stays out of the contract: it is the protocol's message ID, not owner-facing.
 * So do the two counters a room keeps — the agent turns spent since a person wrote, and the
 * message ids already observed, which is what stops a redelivery from spending another turn.
 */
export type ContactRecord = z.infer<typeof contactSchema> & {
  requestKey?: string;
  channelMessage?: IncomingMessage['channelMessage'];
  agentTurns?: number;
  seen?: string[];
  avatarCheckedAt?: string;
  aiPausedAt?: string;
};

export type Contact = z.infer<typeof contactSchema>;

export type Intake =
  | { status: 'approved'; contact: ContactRecord; duplicate?: boolean }
  | { status: 'pending'; announce: boolean }
  | { status: 'blocked' };

/** The held text is released as one message, so it stays inside the run input limit. */
const MAX_HELD_CHARACTERS = 8000;

/** Each channel as the owner and the agent name it. */
export const CHANNEL_NAMES: Record<ChannelType, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  api: 'API',
  email: 'Email',
};

/**
 * Protocols that deliver one message again until they hear back, so a redelivery must be told
 * from a new message by its request key.
 */
const REDELIVERED = new Set<ChannelType>(['email']);

type ContactServices = {
  profiles: ProfileReader;
  sessions: SessionWriter;
  store: Store;
};

/** Who may talk to the agent, decided by the owner and never by the sender. */
export class Contacts {
  constructor(
    private readonly services: ContactServices,
    private readonly clock: Clock = Date.now,
  ) {}

  private title(contact: Pick<ContactRecord, 'type' | 'scope' | 'actorId' | 'displayName'>) {
    return `${CHANNEL_NAMES[contact.type]} · ${contact.displayName ?? contact.actorId}`.slice(
      0,
      160,
    );
  }

  /** The owner-facing shape of a contact. */
  view({
    requestKey: _key,
    channelMessage: _native,
    agentTurns: _turns,
    seen: _seen,
    avatarCheckedAt: _checked,
    aiPausedAt: _paused,
    ...contact
  }: ContactRecord): Contact {
    return contact;
  }

  async read(profileId: string, id: string, reader: Queryable = this.services.store.db) {
    const contact = await findContact(reader, id);

    return assertFound(contact?.profileId === profileId ? contact : null, 'Contact');
  }

  private async openSession(tx: Queryable, contact: ContactRecord) {
    const session = await this.services.sessions.createSession(
      contact.profileId,
      { title: this.title(contact), channel: contact.type },
      tx,
      contact.scope,
      contact.type === 'api' ? API_SESSION_START : undefined,
    );

    return session.id;
  }

  /**
   * Runs inside the channel transaction so that a burst from one stranger produces exactly one
   * request: the second message finds the record the first one wrote, and the identity index
   * has the last word if both reads came back empty. A group is one request for the whole room
   * — the owner decides about the conversation, not about each participant.
   */
  async intake(
    tx: Queryable,
    channel: { id: string; profileId: string; type: ChannelType; allowAllContacts?: boolean },
    message: IncomingMessage,
  ): Promise<Intake> {
    const profileId = channel.profileId;
    const now = nowIso(this.clock);
    const group = message.scope === 'group';
    // The room is the identity of a group contact: whoever writes there is the same request.
    const actorId = group ? message.chatId : message.actorId;

    let existing = await findContactByIdentity(tx, channel.id, message.chatId, actorId);

    if (!existing) {
      const name = group ? message.groupName : message.displayName;
      // A room is still a decision of its own: allowing everyone covers private conversations.
      const allow = !group && channel.allowAllContacts === true;

      const contact: ContactRecord = {
        id: randomUUID(),
        profileId,
        channelId: channel.id,
        type: channel.type,
        scope: message.scope,
        actorId,
        chatId: message.chatId,
        ...(name ? { displayName: name } : {}),
        status: allow ? 'approved' : 'pending',
        aiEnabled: true,
        // Being let in to talk is not being let in to approve: that stays the owner's call.
        canApprove: false,
        // Nothing is held for a room. Releasing it on approval would answer a message that
        // named nobody, which is exactly what a group with several agents must not do.
        ...(group || allow
          ? {}
          : {
              message: message.text,
              requestKey: message.requestKey,
              ...(message.channelMessage ? { channelMessage: message.channelMessage } : {}),
            }),
        createdAt: now,
        updatedAt: now,
      };

      if (await insertContact(tx, contact)) {
        if (!allow) {
          await recordEvent(tx, this.clock, profileId, 'contact.requested', this.view(contact));
          return { status: 'pending', announce: !group };
        }

        const approved = { ...contact, sessionId: await this.openSession(tx, contact) };
        await updateContact(tx, approved);
        await recordEvent(tx, this.clock, profileId, 'contact.approved', this.view(approved));
        return { status: 'approved', contact: approved };
      }

      existing = assertFound(
        await findContactByIdentity(tx, channel.id, message.chatId, actorId),
        'Contact',
      );
    }

    if (existing.status === 'blocked') {
      return { status: 'blocked' };
    }

    // A waiting stranger is told once, and what they keep writing is appended to the same
    // request instead of producing another one. No event is recorded for those later messages:
    // nothing a stranger sends may drive an automatic reply or a panel update in a loop.
    if (existing.status === 'pending') {
      if (
        REDELIVERED.has(channel.type) &&
        (existing.requestKey === message.requestKey || existing.seen?.includes(message.requestKey))
      )
        return { status: 'pending', announce: false };
      const held = existing.message ? `${existing.message}\n\n${message.text}` : message.text;

      if (!group && held !== existing.message && held.length <= MAX_HELD_CHARACTERS) {
        await updateContact(tx, {
          ...existing,
          message: held,
          ...(message.channelMessage ? { channelMessage: message.channelMessage } : {}),
          updatedAt: now,
          ...(REDELIVERED.has(channel.type)
            ? { seen: [...(existing.seen ?? []), message.requestKey] }
            : {}),
        });
      }

      return { status: 'pending', announce: false };
    }

    // Pending messages were released as a single turn. Replaying an appended event after
    // approval must not submit that fragment as another turn (or restage its media).
    if (REDELIVERED.has(channel.type) && existing.seen?.includes(message.requestKey))
      return { status: 'approved', contact: existing, duplicate: true };

    // A renamed room keeps its request: the owner approved the conversation, not its subject.
    const renamed =
      group && message.groupName && message.groupName !== existing.displayName
        ? { displayName: message.groupName }
        : {};

    const current = { ...existing, ...renamed };

    // A session that is gone leaves `sessionId` null by itself, so holding one is knowing it
    // is still there, and a conversation whose session was removed opens another one below.
    if (current.sessionId) {
      if (Object.keys(renamed).length) {
        await updateContact(tx, { ...current, updatedAt: now });
      }

      return { status: 'approved', contact: current };
    }

    const contact: ContactRecord = {
      ...current,
      sessionId: await this.openSession(tx, current),
      updatedAt: now,
    };

    await updateContact(tx, contact);

    return { status: 'approved', contact };
  }

  async list(profileId: string) {
    await this.services.profiles.profile(profileId);

    // Newest first, so a fresh request is never the one a full page leaves out.
    const contacts = await listContacts(this.services.store.db, profileId);

    return contacts
      .map((contact) => this.view(contact))
      .sort(
        (a, b) =>
          Number(b.status === 'pending') - Number(a.status === 'pending') ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
  }

  /**
   * The owner's switches on one conversation: whether the agent answers it, whether the people
   * in it may approve the agent's actions, and what a person is called. Only chat channels have
   * any of them.
   */
  async setSettings(
    profileId: string,
    id: string,
    patch: { aiEnabled?: boolean; canApprove?: boolean; displayName?: string },
    tx: Queryable,
  ): Promise<ContactRecord> {
    const current = await this.read(profileId, id, tx);
    const channel = await findChannel(tx, current.channelId);
    if (!channel || channel.revokedAt)
      throw new GatewayError(409, 'The channel of this contact is disconnected');
    if (channel.type === 'api')
      throw new GatewayError(400, 'Conversation controls are for WhatsApp and Telegram');
    // Approving is answered in the conversation itself, which only a chat channel has.
    if (patch.canApprove && !isChatChannel(channel.type))
      throw new GatewayError(400, 'Approving from the conversation is for WhatsApp and Telegram');
    // A room is called what its members named it, and intake takes that name again each time
    // they change it, so a name given here would not last.
    if (patch.displayName !== undefined && current.scope === 'group')
      throw new GatewayError(400, 'A group keeps the name its members gave it');
    if (patch.displayName !== undefined && !isChatChannel(channel.type))
      throw new GatewayError(400, 'Renaming a contact is for WhatsApp and Telegram');
    const now = nowIso(this.clock);
    const aiEnabled = patch.aiEnabled ?? current.aiEnabled;
    const contact: ContactRecord = {
      ...current,
      aiEnabled,
      canApprove: patch.canApprove ?? current.canApprove,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      updatedAt: now,
      ...(current.aiEnabled !== aiEnabled ? { aiPausedAt: now } : {}),
      ...(!aiEnabled
        ? { message: undefined, channelMessage: undefined, requestKey: undefined }
        : {}),
    };
    await updateContact(tx, contact);
    await recordEvent(tx, this.clock, profileId, 'contact.updated', this.view(contact));
    // The conversation carries the name too: notifications and the agent's own list of
    // conversations read it from there.
    if (patch.displayName !== undefined && contact.sessionId) {
      const session = await renameSession(tx, profileId, contact.sessionId, this.title(contact));
      if (session) await recordEvent(tx, this.clock, profileId, 'session.renamed', session);
    }
    return contact;
  }

  /**
   * Makes an email address the agent has its own business with — one it wrote to, or a person
   * at a service whose mail it expects — an approved contact with a conversation of its own,
   * inside the caller's transaction. A blocked address stays blocked: only the owner lifts that.
   * What a waiting stranger wrote before moves into the new conversation as its history, read
   * there and never answered on its own.
   */
  async correspondent(
    tx: Queryable,
    profileId: string,
    channelId: string,
    address: string,
  ): Promise<ContactRecord> {
    const now = nowIso(this.clock);
    let current = await findContactByIdentity(tx, channelId, address, address);
    if (!current) {
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
      current =
        (await insertContact(tx, contact)) ??
        assertFound(await findContactByIdentity(tx, channelId, address, address), 'Contact');
    }
    if (current.status === 'blocked' || (current.status === 'approved' && current.sessionId))
      return current;

    const sessionId = current.sessionId ?? (await this.openSession(tx, current));
    if (current.message) {
      await insertMessage(
        tx,
        {
          id: stableUuid(`held:${current.id}:${current.requestKey ?? ''}`),
          profileId,
          sessionId,
          role: 'user',
          content: current.message,
          createdAt: now,
        },
        true,
      );
      await tx
        .update(mediaAssets)
        .set({ sessionId, held: false })
        .where(
          and(
            eq(mediaAssets.profileId, profileId),
            eq(mediaAssets.contactId, current.id),
            eq(mediaAssets.held, true),
          ),
        );
    }
    const contact: ContactRecord = {
      ...current,
      status: 'approved',
      sessionId,
      message: undefined,
      channelMessage: undefined,
      requestKey: undefined,
      updatedAt: now,
    };
    await updateContact(tx, contact);
    await recordEvent(tx, this.clock, profileId, 'contact.approved', this.view(contact));
    return contact;
  }

  async approve(profileId: string, id: string): Promise<ContactRecord> {
    return this.services.store.transaction(profileId, async (tx) => {
      const current = await this.read(profileId, id, tx);

      if (current.status === 'approved') {
        return current;
      }

      const contact: ContactRecord = {
        ...current,
        status: 'approved',
        sessionId: current.sessionId ?? (await this.openSession(tx, current)),
        updatedAt: nowIso(this.clock),
      };

      await updateContact(tx, contact);
      await recordEvent(tx, this.clock, profileId, 'contact.approved', this.view(contact));

      return contact;
    });
  }

  async block(profileId: string, id: string): Promise<Contact> {
    return this.services.store.transaction(profileId, async (tx) => {
      const current = await this.read(profileId, id, tx);

      const contact: ContactRecord = {
        ...current,
        status: 'blocked',
        message: undefined,
        channelMessage: undefined,
        requestKey: undefined,
        updatedAt: nowIso(this.clock),
      };

      await updateContact(tx, contact);
      await recordEvent(tx, this.clock, profileId, 'contact.blocked', this.view(contact));

      return this.view(contact);
    });
  }

  /** Releasing the held message is not repeatable: the text is dropped once it reached a run. */
  async release(profileId: string, id: string): Promise<Contact> {
    return this.services.store.transaction(profileId, async (tx) => {
      const current = await this.read(profileId, id, tx);
      const contact: ContactRecord = {
        ...current,
        message: undefined,
        channelMessage: undefined,
        requestKey: undefined,
        updatedAt: nowIso(this.clock),
      };

      await updateContact(tx, contact);
      await tx
        .update(mediaAssets)
        .set({ held: false })
        .where(
          and(
            eq(mediaAssets.profileId, profileId),
            eq(mediaAssets.contactId, id),
            eq(mediaAssets.held, true),
          ),
        );

      return this.view(contact);
    });
  }
}

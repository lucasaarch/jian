import { createHash, randomUUID } from 'node:crypto';
import {
  channelInputSchema,
  type channelSchema,
  type deliverySchema,
  type Group,
  type GroupTurn,
} from '@jian/contracts';
import type { z } from 'zod';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { stableUuid } from '../core/ids.js';
import type { Decisions } from '../decisions/service.js';
import { Errands } from '../errands/service.js';
import { bindMedia, releaseHeldMedia } from '../media/repository.js';
import type { Media } from '../media/service.js';
import type { ProfileReader } from '../profiles/port.js';
import { isUniqueViolation } from '../providers/repository.js';
import type { RunWriter } from '../runs/port.js';
import { issueToken, verifyToken } from '../security/tokens.js';
import type { Vault } from '../security/vault.js';
import type { SessionWriter } from '../sessions/port.js';
import { insertMessage } from '../sessions/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import type { ChannelRequest, ChannelType, DeliveryOutcome, IncomingMessage } from './channel.js';
import { type ContactRecord, Contacts, type Intake } from './contacts.js';
import { conversational } from './conversation.js';
import { type GroupDecision, Groups } from './groups.js';
import { channelLog } from './logging.js';
import { plainText } from './plain.js';
import { ChannelRegistry } from './registry.js';
import {
  findChannel,
  findContactByIdentity,
  findContactBySession,
  findDelivery,
  findLiveChannel,
  hasDelivery,
  insertChannel,
  insertDelivery,
  listChannels,
  listDeliveries,
  listDeliveriesByPhase,
  listGroupContacts,
  markChannelRevoked,
  updateDelivery,
} from './repository.js';
import { findConnection, writeAuthChunks, writeConnection } from './whatsapp/repository.js';

/**
 * `address` is what this connection speaks as on its protocol — the linked WhatsApp account or
 * the bot's own id. It is how a message from another profile of this installation is
 * recognised as an agent's instead of a person's, and it never reaches the owner-facing shape.
 */
export type ChannelRecord = z.infer<typeof channelSchema> & {
  tokenHash: string;
  address?: string;
  handle?: string;
};

/** Where a channel's bot token lives in the vault. Revoking the channel takes it with it. */
export const channelSecret = (channelId: string) => `channel:${channelId}`;

export type DeliveryRecord = z.infer<typeof deliverySchema> & { connectionGeneration?: number };

const DISPATCH_INTERVAL_MS = 2000;
/** What one message holds on the chat protocols; the adapter still enforces its own. */
const MESSAGE_LIMIT = 4000;
/** The longest a part waits behind the composing bubble before it is sent. */
const BETWEEN_MESSAGES_MS = 1200;
const UNCERTAIN_DELIVERY_AFTER_MS = 10 * 60_000;

/** Sent once to a sender the owner has not decided on yet. It must never depend on a run. */
const APPROVAL_NOTICE =
  'This gateway does not know you yet. Its owner was asked to approve this conversation, and your message is waiting for that decision.';

/** Resolves after the wait, or at once when the gateway is shutting down. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const timer = setTimeout(done, ms);

    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }

    signal.addEventListener('abort', done, { once: true });
  });
}

/** Owns access checks and durable delivery state, independently of each protocol adapter. */
type ChannelServices = {
  profiles: ProfileReader;
  sessions: SessionWriter;
  runs: RunWriter;
  store: Store;
  vault: Vault;
  media?: Media;
  decisions?: Pick<Decisions, 'ask'>;
};

export class Channels {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();

  constructor(
    private readonly services: ChannelServices,
    private readonly fetcher: typeof fetch,
    private readonly registry = new ChannelRegistry(),
    private readonly errands = new Errands(services.store),
    private readonly people = new Contacts(services),
    private readonly rooms = new Groups(services.profiles, services.decisions?.ask),
  ) {}

  start() {
    const tick = async () => {
      if (this.stopped) {
        return;
      }

      this.pending = this.dispatch().catch((error) => channelLog('dispatch.failed', {}, error));
      await this.pending;

      if (!this.stopped) {
        this.timer = setTimeout(tick, DISPATCH_INTERVAL_MS);
        this.timer.unref();
      }
    };

    void tick();
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.timer);
    await this.pending;
  }

  private metadata({
    tokenHash: _hash,
    address: _address,
    handle: _handle,
    ...channel
  }: ChannelRecord) {
    return channel;
  }

  /** Asked once, when the channel is connected: a protocol that cannot say stays unidentified. */
  private async identify(type: ChannelType, credential: string) {
    const adapter = this.registry.get(type);

    try {
      return await adapter.identify?.(credential, this.fetcher, this.abort.signal);
    } catch {
      return undefined;
    }
  }

  /** Runs after the channel is stored, so the first update Telegram pushes finds it. */
  private async register(
    record: ChannelRecord,
    credential: string,
    origin: string,
    secret: string,
  ) {
    const adapter = this.registry.get(record.type);

    if (!adapter.register) {
      return undefined;
    }

    try {
      return await adapter.register(
        credential,
        { channelId: record.id, origin, secret },
        this.fetcher,
        this.abort.signal,
      );
    } catch {
      return false;
    }
  }

  /**
   * One channel of each type per profile: connecting is the whole configuration. `origin` is
   * the public address the owner reached the gateway through; without it the protocol is not
   * told where to deliver, and the owner registers the webhook by hand.
   */
  async connect(profileId: string, input: unknown, origin?: string) {
    const { botToken, ...data } = channelInputSchema.parse(input);

    await this.services.profiles.profile(profileId);
    this.registry.get(data.type);

    if (await findLiveChannel(this.services.store.db, profileId, data.type)) {
      throw new GatewayError(409, 'This channel type is already connected');
    }

    const issued = issueToken();
    const identity = botToken ? await this.identify(data.type, botToken) : undefined;

    const record: ChannelRecord = {
      id: randomUUID(),
      profileId,
      type: data.type,
      tokenHash: issued.hash,
      ...(identity?.address ? { address: identity.address } : {}),
      ...(identity?.handle ? { handle: identity.handle } : {}),
      createdAt: new Date().toISOString(),
    };

    await this.services.store.transaction(profileId, async (tx) => {
      // The vault owns the bot token, addressed by this channel; revoking it takes the token.
      if (botToken) {
        await this.services.vault.put(profileId, channelSecret(record.id), botToken, tx);
      }

      try {
        await insertChannel(tx, record);
      } catch (error) {
        // The partial unique index has the last word on one live channel per type. Reaching it
        // means another request connected this type first, which is a conflict for the owner
        // rather than a gateway fault.
        if (isUniqueViolation(error)) {
          throw new GatewayError(409, 'This channel type is already connected');
        }

        throw error;
      }

      await recordEvent(tx, () => Date.parse(record.createdAt), profileId, 'channel.connected', {
        id: record.id,
        type: record.type,
      });
    });

    const webhookRegistered =
      botToken && origin ? await this.register(record, botToken, origin, issued.token) : undefined;

    return {
      ...this.metadata(record),
      webhookToken: issued.token,
      ...(webhookRegistered === undefined ? {} : { webhookRegistered }),
    };
  }

  async list(profileId: string) {
    await this.services.profiles.profile(profileId);

    return (await listChannels(this.services.store.db, profileId)).map((channel) =>
      this.metadata(channel),
    );
  }

  private async revokeWithin(profileId: string, id: string, tx: Queryable): Promise<ChannelRecord> {
    const value = await findChannel(tx, id);
    const channel = assertFound(value?.profileId === profileId ? value : null, 'Channel');
    const record = { ...channel, revokedAt: new Date().toISOString() };

    await markChannelRevoked(tx, id, new Date(record.revokedAt));
    await this.services.vault.discard(profileId, channelSecret(id), tx);

    await recordEvent(tx, () => Date.parse(record.revokedAt), profileId, 'channel.disconnected', {
      id: record.id,
      type: record.type,
    });

    const connection = await findConnection(tx, id);

    if (connection) {
      // Revocation also invalidates linked-device callbacks and removes the recoverable session.
      await writeConnection(tx, {
        id,
        profileId,
        desired: false,
        generation: connection.generation + 1,
        status: 'disconnected',
        updatedAt: record.revokedAt,
      });
      await writeAuthChunks(tx, id, profileId, [], new Date(record.revokedAt));
    }

    return record;
  }

  async revoke(profileId: string, id: string) {
    const record = await this.services.store.transaction(profileId, (tx) =>
      this.revokeWithin(profileId, id, tx),
    );

    return this.metadata(record);
  }

  /**
   * Every live channel disconnected, ahead of deleting the profile they belong to. Takes the
   * caller's transaction rather than opening one of its own: `deleteProfile` already holds this
   * profile's advisory lock for the delete, and a second `store.transaction` call here would
   * queue behind it in another session and never return. A row that cascades from the profile
   * takes its channel with it either way; this is what stops a WhatsApp socket still open in a
   * worker's memory from outliving the row it was reading.
   */
  async revokeAll(profileId: string, tx: Queryable): Promise<void> {
    const live = (await listChannels(tx, profileId)).filter((channel) => !channel.revokedAt);

    for (const channel of live) {
      await this.revokeWithin(profileId, channel.id, tx);
    }
  }

  contacts(profileId: string) {
    return this.people.list(profileId);
  }

  /**
   * Approval is what creates the conversation: the session appears here, and the message that
   * was waiting reaches the agent exactly once, because its text is dropped after it is used.
   */
  async approveContact(profileId: string, contactId: string) {
    const contact = await this.people.approve(profileId, contactId);

    if (!contact.message || !contact.sessionId) {
      return this.people.view(contact);
    }

    const channel = await findChannel(this.services.store.db, contact.channelId);

    if (!channel || channel.revokedAt) {
      throw new GatewayError(409, 'The channel of this contact is disconnected');
    }

    const mediaIds = await this.services.store.transaction(profileId, (tx) =>
      releaseHeldMedia(
        tx,
        profileId,
        contact.id,
        assertFound(contact.sessionId ?? null, 'Session'),
      ),
    );
    await this.submit(
      channel,
      contact,
      contact.message,
      contact.requestKey ?? contact.id,
      undefined,
      undefined,
      mediaIds,
    );

    return this.people.release(profileId, contactId);
  }

  blockContact(profileId: string, contactId: string) {
    return this.people.block(profileId, contactId);
  }

  async receive(id: string, request: ChannelRequest) {
    const adapter = this.registry.get(request.type);
    if (!adapter.webhookHeader) {
      throw new GatewayError(401, 'Channel does not accept webhooks');
    }

    const token = request.headers[adapter.webhookHeader];
    const channel = await findChannel(this.services.store.db, id);

    if (
      !channel ||
      channel.revokedAt ||
      typeof token !== 'string' ||
      token.length > 512 ||
      !verifyToken(token, channel.tokenHash)
    ) {
      throw new GatewayError(401, 'Unauthorized');
    }

    if (channel.type !== adapter.type) {
      throw new GatewayError(400, 'Channel type mismatch');
    }

    const data = adapter.receive(request.payload);

    if (!data) {
      return { accepted: false };
    }

    return this.accept(channel, data);
  }

  /** Called only by the worker that owns an authenticated linked-device connection. */
  async receiveLinked(id: string, input: unknown, generation: number) {
    const channel = assertFound(await findChannel(this.services.store.db, id), 'Channel');
    const adapter = this.registry.get(channel.type);

    const connection = await findConnection(this.services.store.db, id);

    if (
      channel.revokedAt ||
      adapter.webhookHeader ||
      !connection?.desired ||
      connection.generation !== generation
    ) {
      throw new GatewayError(403, 'Linked channel unavailable');
    }

    const data = adapter.receive(input);

    if (!data) {
      return { accepted: false };
    }

    return this.accept(channel, data, generation);
  }

  private async accept(
    channel: ChannelRecord,
    data: IncomingMessage,
    connectionGeneration?: number,
  ) {
    // A message this connection wrote itself is not a turn someone took in the conversation.
    if (channel.address && data.actorId === channel.address) {
      return { accepted: false };
    }

    // Asked before the transaction: an answer from outside must not hold the profile's lock.
    const verdict =
      data.scope === 'group'
        ? await this.rooms.verdict(this.services.store.db, channel, data)
        : undefined;
    const mediaIds: string[] = [];
    const intake = await this.services.store.transaction(
      channel.profileId,
      async (tx): Promise<Intake & { decision?: GroupDecision }> => {
        const outcome = await this.people.intake(tx, channel, data);
        if (outcome.status === 'pending' && outcome.announce)
          await this.notify(tx, channel, data.chatId, connectionGeneration);
        let decision: GroupDecision | undefined;
        if (outcome.status === 'approved' && data.scope === 'group') {
          const profile = await this.services.profiles.profile(channel.profileId, tx);
          decision = await this.rooms.observe(
            tx,
            channel,
            outcome.contact,
            data,
            profile.name,
            verdict,
          );

          // What was not said to the agent is still what it heard: when it is called later, it
          // answers the room with the conversation it followed, like anyone else who was there.
          if (!decision.speak && outcome.contact.sessionId) {
            await insertMessage(
              tx,
              {
                id: stableUuid(`heard:${channel.id}:${data.chatId}:${data.requestKey}`),
                profileId: channel.profileId,
                sessionId: outcome.contact.sessionId,
                role: 'user',
                content: `${data.displayName ?? data.actorId}: ${data.text}${
                  data.media?.length ? '\n[Attachment not opened: it was not sent to you.]' : ''
                }`,
                createdAt: new Date().toISOString(),
              },
              true,
            );
          }
        }
        // Intake and attachment persistence share the approval lock: approval cannot miss pixels.
        if (
          outcome.status !== 'blocked' &&
          (data.scope === 'direct' || outcome.status === 'approved') &&
          (!decision || decision.speak) &&
          this.services.media
        ) {
          const contact =
            outcome.status === 'approved'
              ? outcome.contact
              : await findContactByIdentity(tx, channel.id, data.chatId, data.actorId);
          if (contact)
            for (const [index, media] of (data.media ?? []).entries()) {
              try {
                mediaIds.push(
                  await this.services.media.stage(
                    tx,
                    channel.profileId,
                    contact.id,
                    contact.sessionId,
                    `${channel.id}:${data.requestKey}:${index}`,
                    media,
                  ),
                );
              } catch (error) {
                if (!(error instanceof GatewayError) || ![413, 429].includes(error.statusCode))
                  throw error;
                data.text = `${data.text.slice(0, 7600)}\n[Attachment rejected: ${error.message}]`;
              }
            }
        }
        return { ...outcome, ...(decision ? { decision } : {}) };
      },
    );
    if (intake.status !== 'approved') {
      return { accepted: false, contact: intake.status };
    }

    if (intake.decision && !intake.decision.speak) {
      return { accepted: false, contact: 'approved' as const, silence: intake.decision.reason };
    }

    // The answer to a question the agent put to this contact belongs to the conversation that
    // asked, not to this one: nobody here is waiting for it.
    if (data.scope === 'direct') {
      const errand = await this.services.store.transaction(channel.profileId, (tx) =>
        this.errands.answer(tx, intake.contact.id, data.text, data.requestKey),
      );

      if (errand) {
        const relayed = await this.relay(channel, intake.contact, errand, data, mediaIds);

        // The asking conversation was busy. The answer is on the errand either way, and it
        // still reaches the owner as an ordinary turn rather than disappearing.
        if (relayed) {
          return relayed;
        }
      }
    }

    // In a room the author is part of the message: an agent answers people and colleagues by
    // name, and it can only do that if it reads who wrote what.
    const text =
      data.scope === 'group' ? `${data.displayName ?? data.actorId}: ${data.text}` : data.text;

    const run = await this.submit(
      channel,
      intake.contact,
      text,
      data.requestKey,
      connectionGeneration,
      intake.decision?.turn,
      mediaIds,
    );

    return { accepted: true, runId: run.id, contact: 'approved' as const };
  }

  /**
   * Carries a contact's answer into the conversation that asked. It arrives as a turn there,
   * so the agent is the one who decides how to pass it on to whoever asked.
   */
  private async relay(
    channel: ChannelRecord,
    contact: ContactRecord,
    errand: { id: string; fromSessionId: string; question: string },
    data: IncomingMessage,
    mediaIds: string[] = [],
  ): Promise<{ accepted: true; runId: string; contact: 'approved' } | null> {
    const who = contact.displayName ?? data.displayName ?? contact.actorId;

    try {
      const forwarded =
        mediaIds.length && contact.sessionId && this.services.media
          ? await this.services.media.forward(
              channel.profileId,
              contact.sessionId,
              errand.fromSessionId,
              mediaIds,
            )
          : [];
      const run = await this.services.runs.submit(
        channel.profileId,
        errand.fromSessionId,
        {
          mediaIds: forwarded,
          text: [
            `${who} answered the question you sent them.`,
            `You asked: ${errand.question}`,
            `They replied: ${data.text}`,
          ].join('\n\n'),
          requestKey: createHash('sha256')
            .update(JSON.stringify(['errand', errand.id, data.requestKey]))
            .digest('hex'),
        },
        { activity: 'channel' },
      );

      // The answer arrived in their conversation; it is recorded there as well as carried
      // into the one that asked, or their own history shows a question and no reply.
      if (contact.sessionId) {
        await this.services.store.transaction(channel.profileId, (tx) =>
          insertMessage(
            tx,
            {
              id: stableUuid(`relay:${run.id}:${data.requestKey}`),
              profileId: channel.profileId,
              sessionId: contact.sessionId as string,
              runId: run.id,
              role: 'user',
              content: data.text,
              createdAt: new Date().toISOString(),
            },
            true,
          ),
        );
      }

      if (contact.sessionId && mediaIds.length)
        await this.services.store.transaction(channel.profileId, (tx) =>
          bindMedia(tx, channel.profileId, contact.sessionId as string, mediaIds, run.id),
        );
      await this.deliverRun(channel.profileId, errand.fromSessionId, run.id);

      return { accepted: true, runId: run.id, contact: 'approved' as const };
    } catch {
      return null;
    }
  }

  /** The binding, not the inbound payload, chooses the profile and session. */
  private async submit(
    channel: ChannelRecord,
    contact: ContactRecord,
    text: string,
    requestKey: string,
    connectionGeneration?: number,
    group?: GroupTurn,
    mediaIds: string[] = [],
  ) {
    const sessionId = assertFound(contact.sessionId ?? null, 'Session');

    const run = await this.services.runs.submit(
      channel.profileId,
      sessionId,
      {
        text,
        mediaIds,
        requestKey: createHash('sha256')
          .update(JSON.stringify([channel.id, contact.chatId, contact.actorId, requestKey]))
          .digest('hex'),
      },
      { activity: 'channel', ...(group ? { group } : {}) },
    );

    if (this.registry.get(channel.type).send) {
      await this.services.store.transaction(channel.profileId, async (tx) => {
        if (await findDelivery(tx, run.id)) {
          return;
        }

        const now = new Date().toISOString();

        await insertDelivery(tx, {
          id: run.id,
          runId: run.id,
          profileId: channel.profileId,
          channelId: channel.id,
          chatId: contact.chatId,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
          remoteMessageIds: [],
          saidCount: 0,
          connectionGeneration,
        });
      });
    }

    return run;
  }

  private async notify(
    tx: Queryable,
    channel: ChannelRecord,
    chatId: string,
    connectionGeneration?: number,
  ) {
    if (!this.registry.get(channel.type).send) {
      return;
    }

    const now = new Date().toISOString();

    await insertDelivery(tx, {
      id: randomUUID(),
      profileId: channel.profileId,
      channelId: channel.id,
      chatId,
      notice: APPROVAL_NOTICE,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      remoteMessageIds: [],
      saidCount: 0,
      connectionGeneration,
    });
  }

  /**
   * The rooms this installation is in, with the profiles that sit in each one. A group is a
   * conversation several agents share, so the owner reads it whole instead of once per profile.
   */
  async groups(): Promise<Group[]> {
    const contacts = await listGroupContacts(this.services.store.db);
    const names = new Map<string, string | null>();

    const rooms = new Map<string, Group>();

    for (const contact of contacts) {
      const key = `${contact.type}\u0000${contact.chatId}`;
      const room = rooms.get(key) ?? { type: contact.type, chatId: contact.chatId, profiles: [] };

      if (!names.has(contact.profileId)) {
        const profile = await this.services.profiles.profile(contact.profileId).catch(() => null);

        names.set(contact.profileId, profile?.name ?? null);
      }

      if (contact.displayName && !room.name) {
        room.name = contact.displayName;
      }

      room.profiles.push({
        profileId: contact.profileId,
        name: names.get(contact.profileId) ?? 'Perfil removido',
        contactId: contact.id,
        status: contact.status,
      });

      rooms.set(key, room);
    }

    return [...rooms.values()].map((room) => ({
      ...room,
      profiles: room.profiles.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }

  /**
   * Gives a run its way out to the person. A run created from an incoming message gets this
   * when the message arrives; one created by the gateway itself — a colleague's late answer, a
   * contact's reply — has no incoming message to hang it on, and without this its answer
   * reaches the transcript and nothing else.
   */
  async deliverRun(profileId: string, sessionId: string, runId: string): Promise<void> {
    const contact = await findContactBySession(this.services.store.db, profileId, sessionId);

    if (contact?.status !== 'approved') {
      return;
    }

    // A run already on its way out needs no second exit. A late answer that arrived while the
    // conversation was busy joins the turn in flight instead of starting one, and a second
    // delivery against that turn would replay every message it had already sent.
    if (await hasDelivery(this.services.store.db, runId)) {
      return;
    }

    const connection = await findConnection(this.services.store.db, contact.channelId);
    const now = new Date().toISOString();

    await this.services.store.transaction(profileId, (tx) =>
      insertDelivery(tx, {
        id: randomUUID(),
        profileId,
        channelId: contact.channelId,
        runId,
        chatId: contact.chatId,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        remoteMessageIds: [],
        saidCount: 0,
        ...(connection ? { connectionGeneration: connection.generation } : {}),
      }),
    );
  }

  async deliveries(profileId: string) {
    await this.services.profiles.profile(profileId);

    return listDeliveries(this.services.store.db, profileId);
  }

  async dispatch() {
    await this.recoverUncertainDeliveries();

    const deliveries = await listDeliveriesByPhase(this.services.store.db, 'pending', 20);

    for (const delivery of deliveries) {
      if (this.stopped) {
        return;
      }

      let text = delivery.notice ?? '';
      let commentary: string[] = [];
      // What the room received from the agent itself, not a failure notice the gateway wrote.
      let spoken = Boolean(delivery.notice);

      if (delivery.runId) {
        const run = await this.services.runs.run(delivery.profileId, delivery.runId);

        commentary = run.commentary ?? [];

        if (run.status === 'queued' || run.status === 'running') {
          // Anything the agent has said on its way to a tool goes out now. The answer follows
          // when the run ends, so the chat moves with the work instead of after it.
          if (!(await this.saySoFar(delivery, commentary))) {
            await this.showProgress(delivery);
          }

          continue;
        }

        text =
          run.output ?? 'The agent could not complete this request. Check the gateway for details.';
        spoken = run.output !== undefined;
      }

      const channel = await findChannel(this.services.store.db, delivery.channelId);
      const adapter = channel ? this.registry.get(channel.type) : undefined;

      const generationChanged =
        delivery.connectionGeneration !== undefined &&
        (await findConnection(this.services.store.db, delivery.channelId))?.generation !==
          delivery.connectionGeneration;

      // A linked device can only send from its owning worker. Offline deliveries stay pending.
      if (
        !generationChanged &&
        channel &&
        !channel.revokedAt &&
        adapter?.canSend &&
        !(await adapter.canSend(channel.id))
      ) {
        continue;
      }

      // A run that finished between two ticks leaves its last lines unsent; they belong in
      // front of the answer, not lost.
      await this.saySoFar(delivery, commentary);

      if (!(await this.claimDelivery(delivery))) {
        continue;
      }

      const outcome = await this.deliver(delivery, text);

      await this.services.store.transaction(delivery.profileId, async (tx) => {
        const current = assertFound(await findDelivery(tx, delivery.id), 'Delivery');

        await updateDelivery(tx, {
          ...current,
          ...outcome,
          // A retry keeps the ids of what is already on screen; the attempt confirmed none.
          remoteMessageIds: outcome.remoteMessageIds.length
            ? outcome.remoteMessageIds
            : current.remoteMessageIds,
          updatedAt: new Date().toISOString(),
        });
      });
      channelLog('delivery.result', {
        channelId: delivery.channelId,
        deliveryId: delivery.id,
        runId: delivery.runId ?? undefined,
        status: outcome.status,
      });

      if (outcome.status === 'sent' && channel && spoken) {
        // The paragraphs said while working went out first; the other agents read the turn
        // whole, as the room did. What they missed is logged, not retried: the room has it.
        const turn = [...commentary, text].filter(Boolean).join('\n\n');

        await this.showToOtherAgents(channel, delivery, turn).catch(() =>
          channelLog('delivery.peer_failed', {
            channelId: delivery.channelId,
            deliveryId: delivery.id,
          }),
        );
      }
    }
  }

  /**
   * What an agent said in a room, handed to the installation's other agents in it when the
   * protocol will not. It enters each of them exactly as a message from the room would: kept in
   * their session as something heard, answered only when it calls them, and counted against
   * the room's budget of turns between agents. The delivery id keeps a retried tick from
   * handing it over twice.
   */
  private async showToOtherAgents(channel: ChannelRecord, delivery: DeliveryRecord, text: string) {
    if (!this.registry.get(channel.type).hidesAgentsFromEachOther || !channel.address) {
      return;
    }

    const room = await listGroupContacts(this.services.store.db, {
      type: channel.type,
      chatId: delivery.chatId,
      status: 'approved',
    });

    if (!room.some((contact) => contact.channelId === channel.id)) {
      return;
    }

    const author = await this.services.profiles.profile(channel.profileId);

    for (const contact of room) {
      if (contact.channelId === channel.id) {
        continue;
      }

      const peer = await findChannel(this.services.store.db, contact.channelId);

      if (!peer || peer.revokedAt) {
        continue;
      }

      await this.accept(peer, {
        actorId: channel.address,
        chatId: delivery.chatId,
        text: text.slice(0, 8000),
        requestKey: `agent:${delivery.id}`,
        displayName: author.name,
        scope: 'group',
        ...(contact.displayName ? { groupName: contact.displayName } : {}),
        // An agent cannot mention through the protocol; the handles it writes are its mentions.
        mentions: [...new Set(text.toLowerCase().match(/@[a-z0-9_]{3,64}/g) ?? [])],
      });
    }
  }

  /**
   * Sends what the run has said since the last tick, and reports whether anything went. The
   * count is raised before the send and under the profile lock: two workers, or two ticks,
   * would otherwise both read the same backlog and the person would see it twice. The cost of
   * that order is a message lost to a failing adapter, which is the right way round — a
   * duplicate is confusing and this is commentary, not the answer.
   */
  private async saySoFar(delivery: DeliveryRecord, commentary: string[]): Promise<boolean> {
    if (commentary.length <= delivery.saidCount) {
      return false;
    }

    const claimed = await this.services.store.transaction(delivery.profileId, async (tx) => {
      const current = await findDelivery(tx, delivery.id);

      if (current?.status !== 'pending' || current.saidCount >= commentary.length) {
        return [];
      }

      await updateDelivery(tx, {
        ...current,
        saidCount: commentary.length,
        updatedAt: new Date().toISOString(),
      });

      return commentary.slice(current.saidCount);
    });

    for (const text of claimed) {
      await this.deliver(delivery, text);
    }

    return claimed.length > 0;
  }

  /**
   * While a run is live and silent the chat shows only that the agent is answering. The answer
   * itself is never shown half-written: it arrives when it is finished, as the messages it was
   * written in. Nothing here is history, so a tick that fails is simply skipped.
   */
  private async showProgress(delivery: DeliveryRecord): Promise<void> {
    const channel = await findChannel(this.services.store.db, delivery.channelId);

    if (!channel || channel.revokedAt) {
      return;
    }

    const adapter = this.registry.get(channel.type);

    if (!adapter.typing || (adapter.canSend && !(await adapter.canSend(channel.id)))) {
      return;
    }

    await adapter
      .typing(delivery.chatId, {
        channelId: delivery.channelId,
        connectionGeneration: delivery.connectionGeneration,
        credential: await this.services.vault.read(delivery.profileId, channelSecret(channel.id)),
        fetch: this.fetcher,
        signal: this.abort.signal,
      })
      .catch(() => undefined);
  }

  private async claimDelivery(delivery: DeliveryRecord): Promise<boolean> {
    return this.services.store.transaction(delivery.profileId, async (tx) => {
      const current = await findDelivery(tx, delivery.id);

      if (current?.status !== 'pending') {
        return false;
      }

      // Persist intent before network I/O so another worker cannot send the same delivery.
      await updateDelivery(tx, {
        ...current,
        status: 'sending',
        updatedAt: new Date().toISOString(),
      });

      return true;
    });
  }

  private async deliver(delivery: DeliveryRecord, text: string): Promise<DeliveryOutcome> {
    let attemptedSend = false;

    try {
      const channel = await findChannel(this.services.store.db, delivery.channelId);

      if (!channel || channel.revokedAt) {
        throw new Error('Channel unavailable');
      }

      if (delivery.connectionGeneration !== undefined) {
        const connection = await findConnection(this.services.store.db, delivery.channelId);

        if (!connection?.desired || connection.generation !== delivery.connectionGeneration) {
          throw new Error('Delivery belongs to a disconnected device');
        }
      }

      const adapter = this.registry.get(channel.type);

      const credential = await this.services.vault.read(
        delivery.profileId,
        channelSecret(channel.id),
      );

      if (!adapter.send || (!text && !delivery.mediaId)) {
        throw new Error('Channel does not support delivery');
      }

      attemptedSend = true;

      const context = {
        channelId: delivery.channelId,
        connectionGeneration: delivery.connectionGeneration,
        credential,
        fetch: this.fetcher,
        signal: this.abort.signal,
      };

      if (delivery.mediaId) {
        if (!this.services.media) throw new Error('Media delivery is unavailable');
        const media = await this.services.media.read(delivery.profileId, delivery.mediaId);
        return adapter.send(
          {
            chatId: delivery.chatId,
            text,
            media: {
              mimeType: media.mimeType as import('@jian/contracts').InlineMedia['mimeType'],
              data: media.data,
            },
          },
          context,
        );
      }

      const parts = adapter.rendersMarkdown
        ? [text.trim()]
        : conversational(plainText(text), MESSAGE_LIMIT);

      const remoteMessageIds: Array<string | number> = [];

      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          // Between messages the bubble goes back to composing, and the pause is what keeps a
          // three-part answer from landing as one burst of notifications.
          await adapter.typing?.(delivery.chatId, context).catch(() => undefined);
          await pause(Math.min(BETWEEN_MESSAGES_MS, 200 + part.length * 8), this.abort.signal);
        }

        const outcome = await adapter.send({ chatId: delivery.chatId, text: part }, context);

        remoteMessageIds.push(...outcome.remoteMessageIds);

        if (outcome.status !== 'sent') {
          // Part of the answer is already there, so nothing may be replayed from the start.
          return {
            status: remoteMessageIds.length ? 'unknown' : outcome.status,
            remoteMessageIds,
          };
        }
      }

      return { status: 'sent', remoteMessageIds };
    } catch {
      // An unexpected adapter failure may happen after a remote write. Never retry it blindly.
      return { status: attemptedSend ? 'unknown' : 'failed', remoteMessageIds: [] };
    }
  }

  private async recoverUncertainDeliveries(): Promise<void> {
    const sending = await listDeliveriesByPhase(this.services.store.db, 'sending', 100);

    for (const delivery of sending) {
      if (Date.parse(delivery.updatedAt) > Date.now() - UNCERTAIN_DELIVERY_AFTER_MS) {
        continue;
      }

      await this.services.store.transaction(delivery.profileId, async (tx) => {
        const current = await findDelivery(tx, delivery.id);

        // Recheck under the profile lock: another worker may have confirmed this delivery.
        if (
          current?.status === 'sending' &&
          Date.parse(current.updatedAt) <= Date.now() - UNCERTAIN_DELIVERY_AFTER_MS
        ) {
          await updateDelivery(tx, {
            ...current,
            status: 'unknown',
            updatedAt: new Date().toISOString(),
          });
        }
      });
    }
  }
}

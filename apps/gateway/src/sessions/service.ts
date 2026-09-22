import { randomUUID } from 'node:crypto';
import {
  AGENT_SESSION_CHANNEL,
  type Profile,
  type Session,
  sessionRenameSchema,
  sessionSchema,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  findPeerSession,
  findSession,
  insertSession,
  listSessionMessages,
  listSessions,
  renameSession,
  writeSessionSummary,
} from './repository.js';

/** The lookup a session needs from profiles, reading through whatever transaction it is given. */
type ProfileLookup = {
  profile(id: string, reader?: Queryable): Promise<Profile>;
};

export class Sessions {
  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileLookup,
    private readonly clock: Clock = Date.now,
  ) {}

  /** A caller already inside a profile transaction passes it in: this store never nests locks. */
  async createSession(profileId: string, input: unknown, transaction?: Queryable) {
    const data = sessionSchema.parse(input);

    const write = async (tx: Queryable) => {
      await this.profiles.profile(profileId, tx);

      const session: Session = {
        ...data,
        title: data.title ?? null,
        id: randomUUID(),
        profileId,
        createdAt: nowIso(this.clock),
      };

      await insertSession(tx, session);
      await recordEvent(tx, this.clock, profileId, 'session.created', session);

      return session;
    };

    return transaction ? write(transaction) : this.store.transaction(profileId, write);
  }

  /**
   * Names a conversation. The owner may do this at any time; the agent does it once, from the
   * first message, and only while the name is still empty — a rename is never overwritten.
   */
  async renameSession(profileId: string, sessionId: string, input: unknown) {
    const { title } = sessionRenameSchema.parse(input);

    return this.store.transaction(profileId, async (tx) => {
      const session = assertFound(await renameSession(tx, profileId, sessionId, title), 'Session');

      await recordEvent(tx, this.clock, profileId, 'session.renamed', session);

      return session;
    });
  }

  /** Used by the agent after the first exchange; a session already named is left alone. */
  async nameIfUnnamed(profileId: string, sessionId: string, title: string) {
    await this.store.transaction(profileId, async (tx) => {
      const current = await findSession(tx, profileId, sessionId);

      if (!current || current.title) {
        return;
      }

      const named = await renameSession(tx, profileId, sessionId, title.slice(0, 160));

      if (named) {
        await recordEvent(tx, this.clock, profileId, 'session.renamed', named);
      }
    });
  }

  /**
   * The one session a pair of agents shares, found or opened on the called profile's side, so
   * colleagues keep continuity instead of restarting at every request. It is a session of this
   * profile like any other: the peer cannot read it, and `peerProfileId` is not writable
   * through the public session input, so only a peer call can open one.
   */
  async peerSession(
    profileId: string,
    peerProfileId: string,
    title: string,
    transaction?: Queryable,
  ) {
    const open = async (tx: Queryable) => {
      const existing = await findPeerSession(tx, profileId, peerProfileId);

      if (existing) {
        return existing;
      }

      await this.profiles.profile(profileId, tx);

      const session: Session = {
        ...sessionSchema.parse({ title, channel: AGENT_SESSION_CHANNEL }),
        // A peer session is named by the pair it belongs to, never by the agent.
        title,
        id: randomUUID(),
        profileId,
        peerProfileId,
        createdAt: nowIso(this.clock),
      };

      await insertSession(tx, session);
      await recordEvent(tx, this.clock, profileId, 'session.created', session);

      return session;
    };

    return transaction ? open(transaction) : this.store.transaction(profileId, open);
  }

  /** Belonging to the profile is a condition of the read, so another profile's session is a 404. */
  async session(profileId: string, sessionId: string, reader: Queryable = this.store.db) {
    return assertFound(await findSession(reader, profileId, sessionId), 'Session');
  }

  async sessions(profileId: string) {
    await this.profiles.profile(profileId);

    return listSessions(this.store.db, profileId, 100);
  }

  async messages(profileId: string, sessionId: string, limit = 100, after?: string) {
    await this.session(profileId, sessionId);

    return listSessionMessages(this.store.db, sessionId, limit, after);
  }

  /**
   * Replaces the turns up to `upTo` with the record the agent wrote of them. The messages stay
   * in the database and in the panel: what changes is only what a request carries.
   */
  async summarize(profileId: string, sessionId: string, summary: string, upTo: string) {
    await this.session(profileId, sessionId);

    await writeSessionSummary(this.store.db, sessionId, summary, upTo);
  }
}

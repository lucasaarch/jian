import { randomUUID } from 'node:crypto';
import {
  AGENT_SESSION_CHANNEL,
  GATEWAY_SESSION_CHANNEL,
  gatewaySessionInputSchema,
  gatewaySessionTargetSchema,
  LEARNING_SESSION_CHANNEL,
  type Profile,
  type Session,
  type SessionObjective,
  sessionModelSchema,
  sessionObjectiveInputSchema,
  sessionRenameSchema,
  sessionSchema,
  TASK_SESSION_CHANNEL,
} from '@jian/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { sessionTimeline } from '../runs/timeline.js';
import type { Queryable, Store } from '../storage/database.js';
import { projects, remoteMachines, runs } from '../storage/schema.js';
import { objectiveAt, sanitizeObjectiveText } from './objective.js';
import {
  deleteSession as deleteSessionRecord,
  findOwnSession,
  findPeerSession,
  findSession,
  insertMessage,
  insertSession,
  lastMessages,
  listSessionMessages,
  listSessions,
  listUncompactedMessages,
  renameSession,
  setGatewaySessionTarget,
  setSessionModel,
  setSessionObjective,
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

  /** Creates an owner chat without changing the singleton used by older clients. */
  async createGatewaySession(profileId: string, input: unknown) {
    const data = gatewaySessionInputSchema.parse(input);

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      if (data.projectId) {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, data.projectId), eq(projects.profileId, profileId)))
          .limit(1);
        assertFound(project, 'Project');
      }
      if (data.remoteMachineId) await this.assertMachine(data.remoteMachineId, tx);

      const session: Session = {
        id: randomUUID(),
        profileId,
        title: null,
        channel: GATEWAY_SESSION_CHANNEL,
        ...(data.projectId ? { projectId: data.projectId } : {}),
        ...(data.remoteMachineId ? { remoteMachineId: data.remoteMachineId } : {}),
        createdAt: nowIso(this.clock),
      };
      await insertSession(tx, session);
      await recordEvent(tx, this.clock, profileId, 'session.created', session);
      return session;
    });
  }

  async setGatewayTarget(profileId: string, sessionId: string, input: unknown) {
    const data = gatewaySessionTargetSchema.parse(input);
    return this.store.transaction(profileId, async (tx) => {
      const current = await this.session(profileId, sessionId, tx);
      if (current.channel !== GATEWAY_SESSION_CHANNEL) {
        throw new GatewayError(409, 'Only Gateway chats can change project or machine');
      }
      const [active] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.profileId, profileId),
            eq(runs.sessionId, sessionId),
            inArray(runs.status, ['queued', 'running']),
          ),
        )
        .limit(1);
      if (active) {
        throw new GatewayError(
          409,
          'Wait for this conversation to finish before changing its target',
        );
      }
      if (data.projectId) {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, data.projectId), eq(projects.profileId, profileId)))
          .limit(1);
        assertFound(project, 'Project');
      }
      if (data.remoteMachineId) await this.assertMachine(data.remoteMachineId, tx);
      return assertFound(
        await setGatewaySessionTarget(
          tx,
          profileId,
          sessionId,
          data.projectId,
          data.remoteMachineId,
        ),
        'Session',
      );
    });
  }

  /** Every agent may use every machine; a chat can only aim at one that exists. */
  private async assertMachine(machineId: string, tx: Queryable) {
    const [machine] = await tx
      .select({ id: remoteMachines.id })
      .from(remoteMachines)
      .where(eq(remoteMachines.id, machineId))
      .limit(1);
    if (!machine) throw new GatewayError(404, 'Remote machine not found');
  }

  /** A caller already inside a profile transaction passes it in: this store never nests locks. */
  /** `scope` is the gateway's to set, for a channel conversation; the public input has none. */
  async createSession(
    profileId: string,
    input: unknown,
    transaction?: Queryable,
    scope?: 'direct' | 'group',
  ) {
    const data = sessionSchema.parse(input);

    const write = async (tx: Queryable) => {
      await this.profiles.profile(profileId, tx);

      const session: Session = {
        ...data,
        title: data.title ?? null,
        id: randomUUID(),
        profileId,
        ...(scope ? { scope } : {}),
        createdAt: nowIso(this.clock),
      };

      await insertSession(tx, session);
      await recordEvent(tx, this.clock, profileId, 'session.created', session);

      return session;
    };

    return transaction ? write(transaction) : this.store.transaction(profileId, write);
  }

  /** A private transcript for one ephemeral worker, never a chat the owner can message. */
  async taskSession(profileId: string, title: string, tx: Queryable): Promise<Session> {
    await this.profiles.profile(profileId, tx);
    const session: Session = {
      id: randomUUID(),
      profileId,
      title: title.slice(0, 160),
      channel: TASK_SESSION_CHANNEL,
      createdAt: nowIso(this.clock),
    };
    await insertSession(tx, session);
    return session;
  }

  /**
   * Names a conversation. The owner may do this at any time; the agent does it once, from the
   * first message, and only while the name is still empty — a rename is never overwritten.
   */
  async renameSession(profileId: string, sessionId: string, input: unknown) {
    const { title } = sessionRenameSchema.parse(input);

    return this.store.transaction(profileId, async (tx) => {
      if ((await this.session(profileId, sessionId, tx)).channel === TASK_SESSION_CHANNEL) {
        throw new GatewayError(403, 'Subagent sessions are read-only');
      }
      const session = assertFound(await renameSession(tx, profileId, sessionId, title), 'Session');

      await recordEvent(tx, this.clock, profileId, 'session.renamed', session);

      return session;
    });
  }

  /** Removes a chat and its transcript while leaving a channel contact ready to reopen it. */
  async deleteSession(profileId: string, sessionId: string) {
    return this.store.transaction(profileId, async (tx) => {
      const session = await this.session(profileId, sessionId, tx);
      if (session.channel === LEARNING_SESSION_CHANNEL) {
        throw new GatewayError(409, 'This built-in conversation cannot be deleted');
      }

      const [active] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.profileId, profileId),
            eq(runs.sessionId, sessionId),
            inArray(runs.status, ['queued', 'running']),
          ),
        )
        .limit(1);
      if (active)
        throw new GatewayError(409, 'Wait for this conversation to finish before deleting it');

      const deleted = assertFound(await deleteSessionRecord(tx, profileId, sessionId), 'Session');
      await recordEvent(tx, this.clock, profileId, 'session.deleted', {
        sessionId,
        channel: deleted.channel,
      });
      return deleted;
    });
  }

  /**
   * The model this conversation runs on from its next turn. A turn already under way keeps the
   * model it started with.
   */
  async setModel(profileId: string, sessionId: string, input: unknown) {
    const { model } = sessionModelSchema.parse(input);

    return this.store.transaction(profileId, async (tx) => {
      if ((await this.session(profileId, sessionId, tx)).channel === TASK_SESSION_CHANNEL) {
        throw new GatewayError(403, 'Subagent sessions are read-only');
      }
      const session = assertFound(
        await setSessionModel(tx, profileId, sessionId, model),
        'Session',
      );

      await recordEvent(tx, this.clock, profileId, 'session.model', {
        sessionId,
        model: model ? { providerId: model.providerId, modelId: model.modelId } : null,
      });

      return session;
    });
  }

  /**
   * Sets or closes the durable objective for this conversation. Used by the panel, owner
   * commands, and the agent's objective tools.
   */
  async setObjective(
    profileId: string,
    sessionId: string,
    input: unknown,
    transaction?: Queryable,
  ) {
    // Truncate/sanitize before schema parse so a long paste becomes a short goal, not a 400.
    const prepared =
      input &&
      typeof input === 'object' &&
      'text' in input &&
      typeof (input as { text?: unknown }).text === 'string'
        ? {
            ...(input as Record<string, unknown>),
            text: sanitizeObjectiveText((input as { text: string }).text),
          }
        : input;
    const data = sessionObjectiveInputSchema.parse(prepared);
    const write = async (tx: Queryable) => {
      const current = await this.session(profileId, sessionId, tx);
      if (current.channel === TASK_SESSION_CHANNEL) {
        throw new GatewayError(403, 'Subagent sessions are read-only');
      }
      const at = nowIso(this.clock);
      const status = data.status ?? 'open';
      const text = data.text ?? current.objective?.text;
      if (!text) throw new GatewayError(400, 'An objective needs text');
      const objective = objectiveAt(text, status, at, {
        continuations: status === 'open' && data.text ? 0 : (current.objective?.continuations ?? 0),
        ...(data.note ? { note: data.note } : {}),
      });
      const session = assertFound(
        await setSessionObjective(tx, profileId, sessionId, objective),
        'Session',
      );
      await recordEvent(tx, this.clock, profileId, 'session.objective', {
        sessionId,
        status: objective.status,
        text: objective.text.slice(0, 200),
      });
      return session;
    };
    return transaction ? write(transaction) : this.store.transaction(profileId, write);
  }

  /** Agent/tool helper: write a fully formed objective row. */
  async writeObjective(
    profileId: string,
    sessionId: string,
    objective: SessionObjective,
    transaction?: Queryable,
  ) {
    const write = async (tx: Queryable) => {
      if ((await this.session(profileId, sessionId, tx)).channel === TASK_SESSION_CHANNEL) {
        throw new GatewayError(403, 'Subagent sessions are read-only');
      }
      return assertFound(await setSessionObjective(tx, profileId, sessionId, objective), 'Session');
    };
    return transaction ? write(transaction) : this.store.transaction(profileId, write);
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

  /**
   * Where the agent looks back on its turns and says what it kept. Opened on the first look, and
   * the public session input cannot create another.
   */
  async learningSession(profileId: string) {
    return this.ownSession(profileId, LEARNING_SESSION_CHANNEL, 'Learning');
  }

  private async ownSession(profileId: string, channel: string, title: string) {
    return this.store.transaction(profileId, async (tx) => {
      const existing = await findOwnSession(tx, profileId, channel);

      if (existing) {
        return existing;
      }

      await this.profiles.profile(profileId, tx);

      const session: Session = {
        title,
        channel,
        id: randomUUID(),
        profileId,
        createdAt: nowIso(this.clock),
      };

      await insertSession(tx, session);
      await recordEvent(tx, this.clock, profileId, 'session.created', session);

      return session;
    });
  }

  /** Belonging to the profile is a condition of the read, so another profile's session is a 404. */
  async session(profileId: string, sessionId: string, reader: Queryable = this.store.db) {
    return assertFound(await findSession(reader, profileId, sessionId), 'Session');
  }

  async sessions(profileId: string) {
    await this.profiles.profile(profileId);

    return listSessions(this.store.db, profileId);
  }

  /** The list the panel shows: each session with its last message on one line, newest first. */
  async overview(profileId: string) {
    const [list, last] = await Promise.all([
      this.sessions(profileId),
      lastMessages(this.store.db, profileId),
    ]);

    return list
      .map((session) => {
        const message = last.get(session.id);

        return message
          ? {
              ...session,
              lastMessage: {
                role: message.role,
                // One line of it: media ids and line breaks are not something to read in a list.
                text: message.content
                  .replace(/\[Attached media: [0-9a-f-]{36}\]/g, '📎')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 200),
                at: message.createdAt.toISOString(),
              },
            }
          : session;
      })
      .sort((a, b) =>
        ('lastMessage' in a ? a.lastMessage.at : a.createdAt) <
        ('lastMessage' in b ? b.lastMessage.at : b.createdAt)
          ? 1
          : -1,
      );
  }

  /** The tools the agent used in each recent turn here, for the owner's timeline. */
  async timeline(profileId: string, sessionId: string) {
    await this.session(profileId, sessionId);

    return sessionTimeline(this.store.db, profileId, sessionId);
  }

  /** Writes one turn of a conversation the gateway itself is keeping, such as a peer thread. */
  async record(
    profileId: string,
    sessionId: string,
    runId: string,
    role: 'user' | 'assistant',
    content: string,
    call?: { profileId: string; sessionId: string; runId: string },
  ) {
    await this.store.transaction(profileId, (tx) =>
      insertMessage(tx, {
        id: randomUUID(),
        profileId,
        sessionId,
        runId,
        role,
        content,
        ...(call ? { call } : {}),
        createdAt: nowIso(this.clock),
      }),
    );
  }

  async messages(profileId: string, sessionId: string, limit = 100, after?: string) {
    await this.session(profileId, sessionId);

    return listSessionMessages(this.store.db, sessionId, limit, after);
  }

  async uncompactedMessages(
    profileId: string,
    sessionId: string,
    afterId?: string,
    afterAt?: string,
  ) {
    await this.session(profileId, sessionId);
    return listUncompactedMessages(this.store.db, sessionId, afterId, afterAt);
  }

  /**
   * Replaces the turns up to `upTo` with the record the agent wrote of them. The messages stay
   * in the database and in the panel: what changes is only what a request carries.
   */
  async summarize(
    profileId: string,
    sessionId: string,
    summary: string,
    upTo?: string,
    throughId?: string,
  ) {
    await this.session(profileId, sessionId);

    await writeSessionSummary(this.store.db, sessionId, summary, upTo, throughId);
  }
}

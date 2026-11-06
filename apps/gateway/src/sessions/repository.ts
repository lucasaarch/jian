import {
  AGENT_SESSION_CHANNEL,
  GATEWAY_SESSION_CHANNEL,
  type Message,
  type ModelSelection,
  type ProtectionMode,
  type Session,
  type SessionObjective,
  TASK_SESSION_CHANNEL,
} from '@jian/contracts';
import { and, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { messages, type SessionWorkspace, sessions } from '../storage/schema.js';
import { sanitizeObjectiveText } from './objective.js';

type SessionRow = typeof sessions.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

/** Soft-heal oversized or dump-shaped goals written before the cap existed. */
function readObjective(objective: SessionObjective): SessionObjective {
  return {
    ...objective,
    text: sanitizeObjectiveText(objective.text),
  };
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    profileId: row.profileId,
    title: row.title,
    pinned: row.pinned,
    channel: row.channel,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.remoteMachineId ? { remoteMachineId: row.remoteMachineId } : {}),
    ...(row.workspace?.projectIds?.length ? { projectIds: row.workspace.projectIds } : {}),
    ...(row.workspace?.folders?.length ? { folders: row.workspace.folders } : {}),
    ...(row.workspace?.cloneInto ? { cloneInto: row.workspace.cloneInto } : {}),
    ...(row.peerProfileId ? { peerProfileId: row.peerProfileId } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.summarizedUpTo ? { summarizedUpTo: row.summarizedUpTo.toISOString() } : {}),
    ...(row.summarizedThroughId ? { summarizedThroughId: row.summarizedThroughId } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.objective ? { objective: readObjective(row.objective) } : {}),
    protection: row.protection,
    ...(row.readAt ? { readAt: row.readAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    profileId: row.profileId,
    sessionId: row.sessionId,
    ...(row.runId ? { runId: row.runId } : {}),
    role: row.role,
    content: row.content,
    ...(row.reactions?.length ? { reactions: row.reactions } : {}),
    ...(row.channelMessage ? { channelMessage: row.channelMessage } : {}),
    ...(row.authorId
      ? { author: { id: row.authorId, ...(row.authorName ? { name: row.authorName } : {}) } }
      : {}),
    ...(row.call ? { call: row.call } : {}),
    ...(row.purpose ? { purpose: row.purpose } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/** What goes in the column, or null for the usual chat with nothing beyond one project. */
export function workspaceOfSession(
  session: Pick<Session, 'projectIds' | 'folders' | 'cloneInto'>,
): SessionWorkspace | null {
  const { projectIds, folders, cloneInto } = session;
  return projectIds?.length || folders?.length || cloneInto
    ? {
        ...(projectIds?.length ? { projectIds } : {}),
        ...(folders?.length ? { folders } : {}),
        ...(cloneInto ? { cloneInto } : {}),
      }
    : null;
}

export async function insertSession(db: Queryable, session: Session): Promise<void> {
  await db.insert(sessions).values({
    ...session,
    peerProfileId: session.peerProfileId ?? null,
    scope: session.scope ?? null,
    summary: session.summary ?? null,
    summarizedUpTo: session.summarizedUpTo ? new Date(session.summarizedUpTo) : null,
    summarizedThroughId: session.summarizedThroughId ?? null,
    model: session.model ?? null,
    objective: session.objective ?? null,
    projectId: session.projectId ?? null,
    remoteMachineId: session.remoteMachineId ?? null,
    workspace: workspaceOfSession(session),
    readAt: session.readAt ? new Date(session.readAt) : null,
    createdAt: new Date(session.createdAt),
  });
}

/** The owner read it up to now; a later read never moves the mark back. */
export async function markSessionRead(
  db: Queryable,
  profileId: string,
  sessionId: string,
  at: Date,
) {
  await db
    .update(sessions)
    .set({ readAt: sql`greatest(${sessions.readAt}, ${at})` })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)));
}

/** Ownership is part of the lookup, so another profile's session comes back as nothing at all. */
export async function findSession(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .limit(1);

  return row ? toSession(row) : null;
}

/** Deletes only a profile-owned chat; channel contacts retain their identity and reopen on intake. */
export async function deleteSession(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<Session | null> {
  const [row] = await db
    .delete(sessions)
    .where(and(eq(sessions.profileId, profileId), eq(sessions.id, sessionId)))
    .returning();

  return row ? toSession(row) : null;
}

export type PonytailMode = 'lite' | 'full' | 'ultra' | 'off';
export type CavemanMode = PonytailMode;

/** Caveman is opt-in and only an exact standalone owner command changes its mode. */
export function parseCavemanMode(text: string): CavemanMode | undefined {
  const command = text.trim().toLowerCase();
  if (command === '/caveman' || command === '/caveman full') return 'full';
  if (command === '/caveman lite') return 'lite';
  if (command === '/caveman ultra') return 'ultra';
  if (command === '/caveman off' || command === 'stop caveman') return 'off';
  return undefined;
}

export async function cavemanMode(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<CavemanMode> {
  const [row] = await db
    .select({ mode: sessions.cavemanMode })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .limit(1);

  return row?.mode ?? 'off';
}

export async function setCavemanMode(
  db: Queryable,
  profileId: string,
  sessionId: string,
  mode: CavemanMode,
): Promise<void> {
  await db
    .update(sessions)
    .set({ cavemanMode: mode })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)));
}

/** Only a standalone owner message changes the conversation's coding mode. */
export function parsePonytailMode(text: string): PonytailMode | undefined {
  const command = text.trim().toLowerCase();
  if (command === '/ponytail lite') return 'lite';
  if (command === '/ponytail ultra') return 'ultra';
  if (command === '/ponytail off' || command === 'stop ponytail' || command === 'normal mode')
    return 'off';
  if (command === '/ponytail' || command === '/ponytail full') return 'full';
  return undefined;
}

export async function ponytailMode(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<PonytailMode> {
  const [row] = await db
    .select({ mode: sessions.ponytailMode })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .limit(1);

  return row?.mode ?? 'full';
}

/** Which app the owner last wrote from in this conversation; null for all but the desktop one. */
export async function setLastClient(
  db: Queryable,
  profileId: string,
  sessionId: string,
  client: string | null,
): Promise<void> {
  await db
    .update(sessions)
    .set({ lastClient: client })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)));
}

export async function readLastClient(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ lastClient: sessions.lastClient })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .limit(1);
  return row?.lastClient ?? null;
}

export async function setPonytailMode(
  db: Queryable,
  profileId: string,
  sessionId: string,
  mode: PonytailMode,
): Promise<void> {
  await db
    .update(sessions)
    .set({ ponytailMode: mode })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)));
}

/** Every conversation of the profile, newest first: the panel lists them all, in every channel. */
export async function listSessions(db: Queryable, profileId: string): Promise<Session[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.profileId, profileId), sql`${sessions.channel} <> ${TASK_SESSION_CHANNEL}`),
    )
    .orderBy(desc(sessions.createdAt), desc(sessions.id));

  return rows.map(toSession);
}

/**
 * The newest message of each session, one row per session: what a conversation list shows under
 * each name. Newest first per session, read once for the whole profile.
 */
export async function lastMessages(
  db: Queryable,
  profileId: string,
): Promise<Map<string, { role: 'user' | 'assistant'; content: string; createdAt: Date }>> {
  const rows = await db
    .selectDistinctOn([messages.sessionId], {
      sessionId: messages.sessionId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    // A note telling the agent to carry on was never said in the conversation.
    .where(
      and(eq(messages.profileId, profileId), sql`${messages.purpose} IS DISTINCT FROM 'resume'`),
    )
    .orderBy(messages.sessionId, desc(messages.createdAt));

  return new Map(rows.map(({ sessionId, ...last }) => [sessionId, last]));
}

/** The one session this profile keeps for a peer: a column and an index, never a scan. */
export async function findPeerSession(
  db: Queryable,
  profileId: string,
  peerProfileId: string,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.profileId, profileId),
        eq(sessions.peerProfileId, peerProfileId),
        eq(sessions.channel, AGENT_SESSION_CHANNEL),
      ),
    )
    .limit(1);

  return row ? toSession(row) : null;
}

/** The one internal conversation the gateway keeps for a profile. */
export async function findOwnSession(
  db: Queryable,
  profileId: string,
  channel: string,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.profileId, profileId), eq(sessions.channel, channel)))
    .limit(1);

  return row ? toSession(row) : null;
}

/** What a message row holds; one mapping for every insert so they cannot drift apart. */
function messageValues(message: Message, requestKey?: string) {
  const { author, ...rest } = message;

  return {
    ...rest,
    ...(requestKey ? { requestKey } : {}),
    authorId: author?.id ?? null,
    authorName: author?.name ?? null,
    createdAt: new Date(message.createdAt),
  };
}

export async function insertMessage(
  db: Queryable,
  message: Message,
  repeatable = false,
  requestKey?: string,
): Promise<void> {
  const insert = db.insert(messages).values(messageValues(message, requestKey));
  if (repeatable) await insert.onConflictDoNothing({ target: messages.id });
  else await insert;
}

/**
 * Stores a message a person sent into a turn already running, once. The unique index on the key
 * is the guard when two sends race past the lookup; the loser inserts nothing instead of
 * failing, since a failed statement would abort the whole profile transaction.
 */
export async function insertKeyedMessage(
  db: Queryable,
  message: Message,
  requestKey: string,
): Promise<boolean> {
  const inserted = await db
    .insert(messages)
    .values(messageValues(message, requestKey))
    .onConflictDoNothing()
    .returning({ id: messages.id });

  return inserted.length > 0;
}

/** The run and text of a message already stored under this request key. */
export async function findMessageByKey(
  db: Queryable,
  sessionId: string,
  requestKey: string,
): Promise<{ runId: string | null; content: string } | null> {
  const [row] = await db
    .select({ runId: messages.runId, content: messages.content })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.requestKey, requestKey)))
    .limit(1);

  return row ?? null;
}

/** A message ID never grants access to another profile or conversation. */
export async function findMessage(
  db: Queryable,
  profileId: string,
  sessionId: string,
  id: string,
): Promise<Message | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.profileId, profileId),
        eq(messages.sessionId, sessionId),
        eq(messages.id, id),
      ),
    )
    .limit(1);
  return row ? toMessage(row) : null;
}

type MessageCursor = { createdAt: Date; seq: number };

/** Where a message of this conversation stands; nothing for one that is not of it. */
export async function messageCursor(
  db: Queryable,
  sessionId: string,
  messageId: string,
): Promise<MessageCursor | undefined> {
  const [cursor] = await db
    .select({ createdAt: messages.createdAt, seq: messages.seq })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
    .limit(1);

  return cursor;
}

export async function listSessionMessages(
  db: Queryable,
  sessionId: string,
  limit: number,
  after?: string,
  before?: MessageCursor,
): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        after ? gt(messages.createdAt, new Date(after)) : undefined,
        before
          ? or(
              lt(messages.createdAt, before.createdAt),
              and(eq(messages.createdAt, before.createdAt), lt(messages.seq, before.seq)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.seq))
    .limit(limit);

  return rows.map(toMessage).reverse();
}

/** All turns not yet represented by the session checkpoint, in stable timestamp/id order. */
export async function listUncompactedMessages(
  db: Queryable,
  sessionId: string,
  afterId?: string,
  /** Pre-cursor installations only stored a timestamp; used when `afterId` is missing. */
  afterAt?: string,
): Promise<Message[]> {
  const [cursor] = afterId
    ? await db
        .select({ createdAt: messages.createdAt, id: messages.id })
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.id, afterId)))
        .limit(1)
    : [];
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        cursor
          ? or(
              gt(messages.createdAt, cursor.createdAt),
              and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id)),
            )
          : afterAt
            ? gt(messages.createdAt, new Date(afterAt))
            : undefined,
      ),
    )
    .orderBy(messages.createdAt, messages.id);
  return rows.map(toMessage);
}

/** The conversation as the prompt will carry it from now on, and where that record stops. */
export async function writeSessionSummary(
  db: Queryable,
  sessionId: string,
  summary: string,
  upTo?: string,
  throughId?: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({
      summary,
      ...(upTo ? { summarizedUpTo: new Date(upTo) } : {}),
      ...(throughId ? { summarizedThroughId: throughId } : {}),
    })
    .where(eq(sessions.id, sessionId));
}

/**
 * History pages backwards from a message, and searches by word when asked. The cursor is a
 * message id: its timestamp and id order the page, so a new message cannot shift a page seen.
 */
export async function pageMessages(
  db: Queryable,
  where: { profileId: string; sessionId?: string; before?: string; query?: string; limit: number },
): Promise<{ items: Message[]; nextCursor: string | null }> {
  const conditions = [eq(messages.profileId, where.profileId)];

  if (where.sessionId) {
    conditions.push(eq(messages.sessionId, where.sessionId));
  }

  if (where.query) {
    conditions.push(
      sql`to_tsvector('simple', ${messages.content}) @@ plainto_tsquery('simple', ${where.query})`,
    );
  }

  if (where.before) {
    const [cursor] = await db
      .select({ createdAt: messages.createdAt, id: messages.id })
      .from(messages)
      .where(and(eq(messages.profileId, where.profileId), eq(messages.id, where.before)))
      .limit(1);

    if (cursor) {
      conditions.push(
        or(
          lt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
        ) as ReturnType<typeof eq>,
      );
    }
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(where.limit + 1);

  const page = rows.slice(0, where.limit);

  return {
    items: page.map(toMessage),
    nextCursor: rows.length > where.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Only the owner's own session, and only its name. */
export async function renameSession(
  db: Queryable,
  profileId: string,
  sessionId: string,
  title: string,
): Promise<Session | null> {
  const [row] = await db
    .update(sessions)
    .set({ title })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .returning();

  return row ? toSession(row) : null;
}

export async function setSessionPin(
  db: Queryable,
  profileId: string,
  sessionId: string,
  pinned: boolean,
): Promise<Session | null> {
  const [row] = await db
    .update(sessions)
    .set({ pinned })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .returning();
  return row ? toSession(row) : null;
}

export async function setSessionModel(
  db: Queryable,
  profileId: string,
  sessionId: string,
  model: ModelSelection | null,
): Promise<Session | null> {
  const [row] = await db
    .update(sessions)
    .set({ model })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .returning();

  return row ? toSession(row) : null;
}

export async function setSessionProtection(
  db: Queryable,
  profileId: string,
  sessionId: string,
  protection: ProtectionMode,
): Promise<Session | null> {
  const [row] = await db
    .update(sessions)
    .set({ protection })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .returning();

  return row ? toSession(row) : null;
}

export async function setGatewaySessionTarget(
  db: Queryable,
  profileId: string,
  sessionId: string,
  projectId: string | null,
  remoteMachineId: string | null,
  workspace: SessionWorkspace | null,
): Promise<Session | null> {
  const [row] = await db
    .update(sessions)
    .set({ projectId, remoteMachineId, workspace })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.profileId, profileId),
        eq(sessions.channel, GATEWAY_SESSION_CHANNEL),
      ),
    )
    .returning();
  return row ? toSession(row) : null;
}

export async function setSessionObjective(
  db: Queryable,
  profileId: string,
  sessionId: string,
  objective: SessionObjective | null,
): Promise<Session | null> {
  const [row] = await db
    .update(sessions)
    .set({ objective })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .returning();

  return row ? toSession(row) : null;
}

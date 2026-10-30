import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../storage/database.js';
import { artifacts, leases, mail, messages } from '../storage/schema.js';
import type { ArtifactRecord, LeaseRecord, MailRecord } from './service.js';

type ArtifactRow = typeof artifacts.$inferSelect;
type LeaseRow = typeof leases.$inferSelect;
type MailRow = typeof mail.$inferSelect;

/** An id from a client is any string, and a uuid column rejects the rest as a type error. */
const uuid = z.uuid();

function toArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    runId: row.runId,
    toolName: row.toolName,
    content: row.content,
    bytes: row.bytes,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertArtifact(db: Queryable, artifact: ArtifactRecord): Promise<void> {
  await db.insert(artifacts).values({ ...artifact, createdAt: new Date(artifact.createdAt) });
}

/** Ownership is part of the lookup, so another profile's artifact comes back as nothing at all. */
export async function findArtifact(
  db: Queryable,
  profileId: string,
  id: string,
): Promise<ArtifactRecord | null> {
  if (!uuid.safeParse(id).success) {
    return null;
  }

  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.profileId, profileId)))
    .limit(1);

  return row ? toArtifact(row) : null;
}

/**
 * The lease is keyed by profile and resource. The contract still carries an id, so it is
 * derived from that same pair instead of being stored and kept in step with it.
 */
function leaseId(profileId: string, resource: string): string {
  return `${profileId}:${createHash('sha256').update(resource).digest('hex')}`;
}

function toLease(row: LeaseRow): LeaseRecord {
  return {
    id: leaseId(row.profileId, row.resource),
    profileId: row.profileId,
    resource: row.resource,
    sessionId: row.sessionId,
    fence: row.fence,
    expiresAt: row.expiresAt,
  };
}

/**
 * One statement decides the whole rule. The holder renews its own lease and an expired one is
 * taken over; a live lease held by another session matches no row, updates nothing and returns
 * nothing. The fence is the table's sequence, drawn before the conflict is resolved, so every
 * acquisition — renewal included — carries a number above every fence handed out before it.
 */
export async function acquireLease(
  db: Queryable,
  lease: { profileId: string; resource: string; sessionId: string; expiresAt: number },
  now: number,
): Promise<LeaseRecord | null> {
  const [row] = await db
    .insert(leases)
    .values(lease)
    .onConflictDoUpdate({
      target: [leases.profileId, leases.resource],
      set: { sessionId: lease.sessionId, expiresAt: lease.expiresAt, fence: sql`excluded.fence` },
      setWhere: sql`${leases.expiresAt} <= ${now} or ${leases.sessionId} = ${lease.sessionId}`,
    })
    .returning();

  return row ? toLease(row) : null;
}

export async function findLease(
  db: Queryable,
  profileId: string,
  resource: string,
): Promise<LeaseRecord | null> {
  const [row] = await db
    .select()
    .from(leases)
    .where(and(eq(leases.profileId, profileId), eq(leases.resource, resource)))
    .limit(1);

  return row ? toLease(row) : null;
}

/** A release expires the row instead of deleting it, so the resource keeps its last fence. */
export async function expireLease(
  db: Queryable,
  profileId: string,
  resource: string,
  at: number,
): Promise<void> {
  await db
    .update(leases)
    .set({ expiresAt: at })
    .where(and(eq(leases.profileId, profileId), eq(leases.resource, resource)));
}

function toMail(row: MailRow): MailRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    fromSessionId: row.fromSessionId,
    toSessionId: row.toSessionId,
    text: row.text,
    requestKey: row.requestKey,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The request key is unique per profile, so a resend collides instead of writing a second
 * message. The same message again rewrites nothing that is read back and returns the one
 * already stored, with its original id; a different message under that key matches no row and
 * returns none, which is the caller reusing a key.
 */
export async function insertMail(
  db: Queryable,
  record: MailRecord,
): Promise<{ record: MailRecord; created: boolean } | null> {
  const [row] = await db
    .insert(mail)
    .values({ ...record, createdAt: new Date(record.createdAt) })
    .onConflictDoUpdate({
      target: [mail.profileId, mail.fromSessionId, mail.requestKey],
      set: { text: sql`excluded.text` },
      setWhere: sql`
        ${mail.text} = excluded.text
        and ${mail.toSessionId} = excluded.to_session_id
      `,
    })
    .returning();

  return row ? { record: toMail(row), created: row.id === record.id } : null;
}

export async function listInbox(
  db: Queryable,
  profileId: string,
  sessionId: string,
  limit: number,
): Promise<MailRecord[]> {
  const rows = await db
    .select()
    .from(mail)
    .where(and(eq(mail.profileId, profileId), eq(mail.toSessionId, sessionId)))
    .orderBy(desc(mail.createdAt), desc(mail.id))
    .limit(limit);

  return rows.map(toMail);
}

/**
 * A history cursor is a message id, so it is only usable by the profile — and the session —
 * that owns the message. Anything else pages nothing and is reported as not found.
 */
export async function findHistoryCursor(
  db: Queryable,
  profileId: string,
  sessionId: string | undefined,
  id: string,
): Promise<{ id: string } | null> {
  if (!uuid.safeParse(id).success) {
    return null;
  }

  const conditions = [eq(messages.profileId, profileId), eq(messages.id, id)];

  if (sessionId) {
    conditions.push(eq(messages.sessionId, sessionId));
  }

  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(...conditions))
    .limit(1);

  return row ?? null;
}

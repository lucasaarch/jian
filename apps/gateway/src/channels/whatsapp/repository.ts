import { and, count, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { EncryptedSecret } from '../../security/crypto.js';
import type { Queryable } from '../../storage/database.js';
import { channelAuth, channelConnections, channelInbox, channels } from '../../storage/schema.js';
import type { IncomingMessage } from '../channel.js';
import type { ConnectionRecord, ConnectionStatus, InboxRecord } from './types.js';

type ConnectionRow = typeof channelConnections.$inferSelect;
type InboxRow = typeof channelInbox.$inferSelect;

function toConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.channelId,
    profileId: row.profileId,
    desired: row.desired,
    generation: row.generation,
    ...(row.fence === null ? {} : { fence: row.fence }),
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    ...(row.owner ? { owner: row.owner } : {}),
    ...(row.leaseUntil === null ? {} : { leaseUntil: row.leaseUntil }),
    ...(row.retryAt === null ? {} : { retryAt: row.retryAt }),
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.sessionSavedAt ? { sessionSavedAt: row.sessionSavedAt.toISOString() } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.qr ? { qr: row.qr as EncryptedSecret } : {}),
    ...(row.qrExpiresAt === null ? {} : { qrExpiresAt: row.qrExpiresAt }),
  };
}

/** Every field of the row, so a write that leaves one out clears it, as replacing the record did. */
function toConnectionRow(record: ConnectionRecord): typeof channelConnections.$inferInsert {
  return {
    channelId: record.id,
    profileId: record.profileId,
    desired: record.desired,
    generation: record.generation,
    fence: record.fence ?? null,
    status: record.status,
    owner: record.owner ?? null,
    leaseUntil: record.leaseUntil ?? null,
    retryAt: record.retryAt ?? null,
    accountId: record.accountId ?? null,
    sessionSavedAt: record.sessionSavedAt ? new Date(record.sessionSavedAt) : null,
    error: record.error ?? null,
    qr: record.qr ?? null,
    qrExpiresAt: record.qrExpiresAt ?? null,
    updatedAt: new Date(record.updatedAt),
  };
}

export async function findConnection(
  db: Queryable,
  channelId: string,
): Promise<ConnectionRecord | null> {
  const [row] = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.channelId, channelId))
    .limit(1);

  return row ? toConnection(row) : null;
}

/** Every device of the installation: the worker sweeps them all, not one profile's. */
export async function listConnections(db: Queryable, limit: number): Promise<ConnectionRecord[]> {
  const rows = await db.select().from(channelConnections).limit(limit);

  return rows.map(toConnection);
}

export async function listConnectionsOwnedBy(
  db: Queryable,
  owner: string,
  limit: number,
): Promise<ConnectionRecord[]> {
  const rows = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.owner, owner))
    .limit(limit);

  return rows.map(toConnection);
}

export async function writeConnection(db: Queryable, record: ConnectionRecord): Promise<void> {
  const row = toConnectionRow(record);
  const { channelId: _channel, profileId: _profile, ...rest } = row;

  await db
    .insert(channelConnections)
    .values(row)
    .onConflictDoUpdate({ target: channelConnections.channelId, set: rest });
}

/** Ownership of the device socket: mine, unexpired, and still the generation and fence I opened. */
function ownership(record: ConnectionRecord, owner: string, now: number) {
  return and(
    eq(channelConnections.channelId, record.id),
    eq(channelConnections.desired, true),
    eq(channelConnections.owner, owner),
    eq(channelConnections.generation, record.generation),
    record.fence === undefined
      ? isNull(channelConnections.fence)
      : eq(channelConnections.fence, record.fence),
    sql`coalesce(${channelConnections.leaseUntil}, 0) > ${now}`,
    sql`exists (select 1 from ${channels} where ${channels.id} = ${channelConnections.channelId} and ${channels.revokedAt} is null)`,
  );
}

export async function readOwned(
  db: Queryable,
  record: ConnectionRecord,
  owner: string,
  now: number,
): Promise<ConnectionRecord | null> {
  const [row] = await db
    .select()
    .from(channelConnections)
    .where(ownership(record, owner, now))
    .limit(1);

  return row ? toConnection(row) : null;
}

/**
 * Writes the columns the patch names, and only while the lease still holds: a worker that lost
 * the device to an expired reservation cannot land a late callback on the new owner's row. A
 * column the patch leaves out keeps what the row has, so nothing has to be read back first.
 */
export async function updateOwned(
  db: Queryable,
  record: ConnectionRecord,
  owner: string,
  now: number,
  patch: Partial<ConnectionRecord>,
): Promise<ConnectionRecord | null> {
  const next = toConnectionRow({ ...record, ...patch });
  // A field set to `undefined` is still named by the patch, and naming it is what clears it.
  const named = (key: keyof ConnectionRecord) => key in patch;

  const [row] = await db
    .update(channelConnections)
    .set({
      ...(named('desired') ? { desired: next.desired } : {}),
      ...(named('generation') ? { generation: next.generation } : {}),
      ...(named('fence') ? { fence: next.fence } : {}),
      ...(named('status') ? { status: next.status } : {}),
      ...(named('owner') ? { owner: next.owner } : {}),
      ...(named('leaseUntil') ? { leaseUntil: next.leaseUntil } : {}),
      ...(named('retryAt') ? { retryAt: next.retryAt } : {}),
      ...(named('accountId') ? { accountId: next.accountId } : {}),
      ...(named('sessionSavedAt') ? { sessionSavedAt: next.sessionSavedAt } : {}),
      ...(named('error') ? { error: next.error } : {}),
      ...(named('qr') ? { qr: next.qr } : {}),
      ...(named('qrExpiresAt') ? { qrExpiresAt: next.qrExpiresAt } : {}),
      ...(named('updatedAt') ? { updatedAt: next.updatedAt } : {}),
    })
    .where(ownership(record, owner, now))
    .returning();

  return row ? toConnection(row) : null;
}

/**
 * Takes the device over in one statement: the reservation is granted when it is already mine or
 * has run out, which is the whole decision — no read, no gap between deciding and writing.
 * A device this worker does not already hold starts a new fence, so the callbacks of a socket
 * opened under the previous one no longer land.
 */
export async function claimConnection(
  db: Queryable,
  channelId: string,
  owner: string,
  now: number,
  leaseMs: number,
  holdsDevice: boolean,
): Promise<ConnectionRecord | null> {
  const [row] = await db
    .update(channelConnections)
    .set({
      owner,
      leaseUntil: now + leaseMs,
      ...(holdsDevice
        ? {}
        : {
            status: 'connecting',
            qr: null,
            qrExpiresAt: null,
            fence: sql`coalesce(${channelConnections.fence}, 0) + 1`,
          }),
    })
    .where(
      and(
        eq(channelConnections.channelId, channelId),
        eq(channelConnections.desired, true),
        or(
          eq(channelConnections.owner, owner),
          lte(sql`coalesce(${channelConnections.leaseUntil}, 0)`, now),
        ),
      ),
    )
    .returning();

  return row ? toConnection(row) : null;
}

/** Releasing on shutdown: only rows this worker still owns, and only their lease fields. */
export async function releaseConnection(
  db: Queryable,
  channelId: string,
  owner: string,
  status: ConnectionStatus | undefined,
): Promise<void> {
  await db
    .update(channelConnections)
    .set({
      owner: null,
      leaseUntil: 0,
      qr: null,
      qrExpiresAt: null,
      ...(status ? { status: status } : {}),
    })
    .where(and(eq(channelConnections.channelId, channelId), eq(channelConnections.owner, owner)));
}

export async function readAuthChunks(
  db: Queryable,
  channelId: string,
): Promise<EncryptedSecret[] | null> {
  const [row] = await db
    .select({ chunks: channelAuth.chunks })
    .from(channelAuth)
    .where(eq(channelAuth.channelId, channelId))
    .limit(1);

  return row ? (row.chunks as EncryptedSecret[]) : null;
}

/** The device's own credential: chunks of ciphertext the gateway stores and never reads. */
export async function writeAuthChunks(
  db: Queryable,
  channelId: string,
  profileId: string,
  chunks: EncryptedSecret[],
  at: Date,
): Promise<void> {
  await db
    .insert(channelAuth)
    .values({ channelId, profileId, chunks, updatedAt: at })
    .onConflictDoUpdate({ target: channelAuth.channelId, set: { chunks, updatedAt: at } });
}

function toInbox(row: InboxRow): InboxRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    channelId: row.channelId,
    generation: row.generation,
    message: row.message as IncomingMessage,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
  };
}

export async function findInboxItem(db: Queryable, id: string): Promise<InboxRecord | null> {
  const [row] = await db.select().from(channelInbox).where(eq(channelInbox.id, id)).limit(1);

  return row ? toInbox(row) : null;
}

export async function countPendingInbox(db: Queryable, channelId: string): Promise<number> {
  const [row] = await db
    .select({ pending: count() })
    .from(channelInbox)
    .where(and(eq(channelInbox.channelId, channelId), eq(channelInbox.status, 'pending')));

  return row?.pending ?? 0;
}

/** Oldest first: what the device received is replayed in the order it arrived. */
export async function listPendingInbox(
  db: Queryable,
  channelId: string,
  limit: number,
): Promise<InboxRecord[]> {
  const rows = await db
    .select()
    .from(channelInbox)
    .where(and(eq(channelInbox.channelId, channelId), eq(channelInbox.status, 'pending')))
    .orderBy(channelInbox.receivedAt)
    .limit(limit);

  return rows.map(toInbox);
}

export async function insertInboxItem(db: Queryable, record: InboxRecord): Promise<void> {
  await db
    .insert(channelInbox)
    .values({
      id: record.id,
      profileId: record.profileId,
      channelId: record.channelId,
      generation: record.generation,
      message: record.message,
      status: record.status,
      receivedAt: new Date(record.receivedAt),
    })
    .onConflictDoNothing();
}

export async function settleInboxItem(
  db: Queryable,
  record: InboxRecord,
  status: InboxRecord['status'],
): Promise<void> {
  await db
    .update(channelInbox)
    // The text is dropped once the message left the inbox: it lives in the run from here on.
    .set({ status, message: { ...record.message, text: '', media: undefined } })
    .where(eq(channelInbox.id, record.id));
}

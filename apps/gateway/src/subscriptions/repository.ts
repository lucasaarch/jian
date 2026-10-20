import type { Subscription, SubscriptionDelivery, SubscriptionObservation } from '@jian/contracts';
import { and, asc, desc, eq, isNotNull, lte } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { subscriptionDeliveries, subscriptions } from '../storage/schema.js';

type Row = typeof subscriptions.$inferSelect;
type DeliveryRow = typeof subscriptionDeliveries.$inferSelect;

export function toSubscription(row: Row): Subscription {
  return {
    id: row.id,
    profileId: row.profileId,
    name: row.name,
    instruction: row.instruction,
    sessionId: row.sessionId,
    source: row.source,
    filter: row.filter,
    enabled: row.enabled,
    createdBy: row.createdBy,
    ...(row.nextPollAt ? { nextPollAt: row.nextPollAt.toISOString() } : {}),
    ...(row.lastObservation ? { lastObservation: row.lastObservation } : {}),
    ...(row.lastWakeAt ? { lastWakeAt: row.lastWakeAt.toISOString() } : {}),
    ...(row.lastRunId ? { lastRunId: row.lastRunId } : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRow(subscription: Subscription, secretHash: string): typeof subscriptions.$inferInsert {
  return {
    id: subscription.id,
    profileId: subscription.profileId,
    sessionId: subscription.sessionId,
    name: subscription.name,
    instruction: subscription.instruction,
    source: subscription.source,
    filter: subscription.filter,
    enabled: subscription.enabled,
    createdBy: subscription.createdBy,
    secretHash,
    nextPollAt: subscription.nextPollAt ? new Date(subscription.nextPollAt) : null,
    lastObservation: (subscription.lastObservation as SubscriptionObservation | undefined) ?? null,
    lastWakeAt: subscription.lastWakeAt ? new Date(subscription.lastWakeAt) : null,
    lastRunId: subscription.lastRunId ?? null,
    lastError: subscription.lastError ?? null,
    expiresAt: new Date(subscription.expiresAt),
    createdAt: new Date(subscription.createdAt),
    updatedAt: new Date(subscription.updatedAt),
  };
}

export function toDelivery(row: DeliveryRow): SubscriptionDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    profileId: row.profileId,
    deliveryKey: row.deliveryKey,
    event: row.event,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listSubscriptions(db: Queryable, profileId: string) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.profileId, profileId))
    .orderBy(asc(subscriptions.createdAt));
  return rows.map(toSubscription);
}

export async function findSubscription(db: Queryable, profileId: string, id: string) {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.profileId, profileId), eq(subscriptions.id, id)))
    .limit(1);
  return row ? toSubscription(row) : null;
}

export async function findSubscriptionById(db: Queryable, id: string) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
  return row ?? null;
}

/** Enabled subscriptions whose next poll time has come. */
export async function dueSubscriptions(db: Queryable, now: Date) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.enabled, true),
        isNotNull(subscriptions.nextPollAt),
        lte(subscriptions.nextPollAt, now),
      ),
    )
    .orderBy(asc(subscriptions.nextPollAt))
    .limit(50);
  return rows.map(toSubscription);
}

export async function insertSubscription(
  db: Queryable,
  subscription: Subscription,
  secretHash: string,
) {
  await db.insert(subscriptions).values(toRow(subscription, secretHash));
}

export async function replaceSubscription(
  db: Queryable,
  subscription: Subscription,
  secretHash: string,
) {
  await db
    .update(subscriptions)
    .set(toRow(subscription, secretHash))
    .where(eq(subscriptions.id, subscription.id));
}

export async function deleteSubscription(db: Queryable, profileId: string, id: string) {
  await db
    .delete(subscriptions)
    .where(and(eq(subscriptions.profileId, profileId), eq(subscriptions.id, id)));
}

export async function listDeliveries(db: Queryable, profileId: string, subscriptionId: string) {
  const rows = await db
    .select()
    .from(subscriptionDeliveries)
    .where(
      and(
        eq(subscriptionDeliveries.profileId, profileId),
        eq(subscriptionDeliveries.subscriptionId, subscriptionId),
      ),
    )
    .orderBy(desc(subscriptionDeliveries.createdAt))
    .limit(50);
  return rows.map(toDelivery);
}

export async function findDeliveryByKey(
  db: Queryable,
  subscriptionId: string,
  deliveryKey: string,
) {
  const [row] = await db
    .select()
    .from(subscriptionDeliveries)
    .where(
      and(
        eq(subscriptionDeliveries.subscriptionId, subscriptionId),
        eq(subscriptionDeliveries.deliveryKey, deliveryKey),
      ),
    )
    .limit(1);
  return row ? toDelivery(row) : null;
}

export async function insertDelivery(db: Queryable, delivery: SubscriptionDelivery) {
  await db.insert(subscriptionDeliveries).values({
    id: delivery.id,
    subscriptionId: delivery.subscriptionId,
    profileId: delivery.profileId,
    deliveryKey: delivery.deliveryKey,
    event: delivery.event,
    runId: delivery.runId ?? null,
    error: delivery.error ?? null,
    createdAt: new Date(delivery.createdAt),
  });
}

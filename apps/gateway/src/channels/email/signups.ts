import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Queryable } from '../../storage/database.js';
import { emailWindows } from '../../storage/schema.js';

/**
 * How long a signup waits for the service's mail, in milliseconds: a confirmation code arrives
 * within minutes, and the shorter the wait, the less a stranger at that domain can slip in.
 */
export const SIGNUP_WINDOW_MS = 30 * 60 * 1000;
/** Emails one window brings in at most: a code, a resent code, a welcome; then it closes. */
export const SIGNUP_EMAILS = 5;

export type SignupWindow = typeof emailWindows.$inferSelect;

/** `contabo.com` from what the agent typed: an address, `@contabo.com`, or the domain itself. */
export function signupDomain(value: string): string | undefined {
  const domain = value.trim().toLowerCase().replace(/^.*@/, '').replace(/\.$/, '');
  return /^(?=.{3,100}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/.test(domain)
    ? domain
    : undefined;
}

/**
 * The domains a window may have been opened for to take mail from this address: its own and
 * each parent with a dot in it, so `noreply@mail.contabo.com` reaches a wait for `contabo.com`
 * and never one for `com`.
 */
function parents(address: string): string[] {
  const labels = address.slice(address.lastIndexOf('@') + 1).split('.');
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
}

/** Opens or extends this conversation's wait for mail from a domain. */
export async function openSignupWindow(
  db: Queryable,
  window: {
    profileId: string;
    channelId: string;
    sessionId: string;
    domain: string;
    reason: string;
  },
  now: number,
) {
  const expiresAt = new Date(now + SIGNUP_WINDOW_MS);
  // Waits that ended hold nothing worth keeping; the profile's are cleared as it opens one.
  await db
    .delete(emailWindows)
    .where(
      and(eq(emailWindows.profileId, window.profileId), lte(emailWindows.expiresAt, new Date(now))),
    );
  const [row] = await db
    .insert(emailWindows)
    .values({ id: randomUUID(), ...window, expiresAt, createdAt: new Date(now) })
    .onConflictDoUpdate({
      target: [emailWindows.sessionId, emailWindows.domain],
      // A new signup attempt, or a code asked for again, is a new wait.
      set: { reason: window.reason, channelId: window.channelId, expiresAt, received: 0 },
    })
    .returning();
  return row;
}

function openFor(channelId: string, address: string, now: number) {
  return and(
    eq(emailWindows.channelId, channelId),
    inArray(emailWindows.domain, parents(address)),
    gt(emailWindows.expiresAt, new Date(now)),
    lt(emailWindows.received, SIGNUP_EMAILS),
  );
}

/** Whether mail from this address would be taken by a wait, without taking it. */
export async function awaitedSignup(
  db: Queryable,
  channelId: string,
  address: string,
  now: number,
) {
  const [row] = await db
    .select({ id: emailWindows.id })
    .from(emailWindows)
    .where(openFor(channelId, address, now))
    .limit(1);
  return Boolean(row);
}

/**
 * Takes one email from this address into the newest open wait for its domain, and returns that
 * wait. Counted in the same statement that matches it, so two emails at once cannot both pass
 * the last place.
 */
export async function takeSignupEmail(
  db: Queryable,
  channelId: string,
  address: string,
  now: number,
) {
  const [newest] = await db
    .select({ id: emailWindows.id })
    .from(emailWindows)
    .where(openFor(channelId, address, now))
    .orderBy(desc(emailWindows.expiresAt))
    .limit(1);
  if (!newest) return undefined;
  const [taken] = await db
    .update(emailWindows)
    .set({ received: sql`${emailWindows.received} + 1` })
    .where(and(eq(emailWindows.id, newest.id), openFor(channelId, address, now)))
    .returning();
  return taken;
}

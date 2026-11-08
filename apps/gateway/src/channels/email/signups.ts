import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { Queryable } from '../../storage/database.js';
import { emailDomains } from '../../storage/schema.js';

/**
 * How long the agent expects mail from a service it signed up to, in milliseconds: a support desk
 * or a renewal notice writes days or weeks later, not in the minutes a code takes. Each call to
 * `expect_email` counts it again from then.
 */
export const EXPECTED_MS = 30 * 24 * 60 * 60 * 1000;

export type ExpectedDomain = typeof emailDomains.$inferSelect;

/**
 * Mailbox providers anyone can open an address at. Expecting mail from one would let every
 * stranger with an address there in, and two addresses there are not colleagues of one desk.
 */
const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'mail.ru',
  'zoho.com',
  'uol.com.br',
  'bol.com.br',
  'terra.com.br',
  'ig.com.br',
]);
/** Providers with a domain per country: `yahoo.com.br`, `gmx.de`, `yandex.ru` and the like. */
const FREE_MAIL_BRANDS = /^(?:yahoo|gmx|yandex)\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

/** `contabo.com` from what the agent typed: an address, `@contabo.com`, or the domain itself. */
export function signupDomain(value: string): string | undefined {
  const domain = value.trim().toLowerCase().replace(/^.*@/, '').replace(/\.$/, '');
  return /^(?=.{3,100}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/.test(domain)
    ? domain
    : undefined;
}

/**
 * The domains mail from this address or domain may have been expected under: its own and each
 * parent with a dot in it, so `noreply@mail.contabo.com` matches `contabo.com` and never `com`.
 */
function parents(address: string): string[] {
  const labels = address.slice(address.lastIndexOf('@') + 1).split('.');
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
}

/** Whether this address or domain is at a mailbox provider, a subdomain of one included. */
export function freeMail(address: string): boolean {
  return parents(address.toLowerCase()).some(
    (domain) => FREE_MAIL.has(domain) || FREE_MAIL_BRANDS.test(domain),
  );
}

/** Starts or extends expecting mail from a domain on this channel. */
export async function expectDomain(
  db: Queryable,
  expected: { profileId: string; channelId: string; domain: string; reason: string },
  now: number,
) {
  const expiresAt = new Date(now + EXPECTED_MS);
  // What ran out holds nothing worth keeping; the profile's are cleared as it expects another.
  await db
    .delete(emailDomains)
    .where(
      and(
        eq(emailDomains.profileId, expected.profileId),
        lte(emailDomains.expiresAt, new Date(now)),
      ),
    );
  const [row] = await db
    .insert(emailDomains)
    .values({ id: randomUUID(), ...expected, expiresAt, createdAt: new Date(now) })
    .onConflictDoUpdate({
      target: [emailDomains.channelId, emailDomains.domain],
      set: { reason: expected.reason, expiresAt },
    })
    .returning();
  return row;
}

/** The expected domain mail from this address falls under, while it is expected. */
export async function expectedDomain(
  db: Queryable,
  channelId: string,
  address: string,
  now: number,
): Promise<ExpectedDomain | undefined> {
  const [row] = await db
    .select()
    .from(emailDomains)
    .where(
      and(
        eq(emailDomains.channelId, channelId),
        inArray(emailDomains.domain, parents(address)),
        gt(emailDomains.expiresAt, new Date(now)),
      ),
    )
    .orderBy(desc(emailDomains.expiresAt))
    .limit(1);
  return row;
}

/** Keeps the email conversation this domain's automatic mail goes to. */
export async function setDomainSession(db: Queryable, id: string, sessionId: string) {
  await db.update(emailDomains).set({ sessionId }).where(eq(emailDomains.id, id));
}

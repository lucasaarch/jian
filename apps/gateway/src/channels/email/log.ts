import { and, desc, eq, ilike, like, or, type SQL } from 'drizzle-orm';
import { stableUuid } from '../../core/ids.js';
import type { Queryable } from '../../storage/database.js';
import { emailLog } from '../../storage/schema.js';

/** What one logged email keeps of its text: as much as the agent reads of one received. */
const LOG_CHARS = 8000;
/** What a search returns of each email's text, in characters: enough to read a reply. */
export const SEARCH_TEXT_CHARS = 2000;
export const SEARCH_LIMIT = 20;

export type LoggedEmail = {
  profileId: string;
  channelId: string;
  direction: 'received' | 'sent';
  address: string;
  subject: string;
  text: string;
  /** The provider's email id or the delivery's: the same email logged twice is one row. */
  key: string;
};

export async function logEmail(db: Queryable, email: LoggedEmail) {
  const { key, ...row } = email;
  await db
    .insert(emailLog)
    .values({
      ...row,
      id: stableUuid(`email-log:${email.channelId}:${email.direction}:${key}`),
      text: row.text.slice(0, LOG_CHARS),
      subject: row.subject.slice(0, 300),
    })
    .onConflictDoNothing();
}

export type EmailSearch = {
  /** An address, or a domain that also matches its subdomains. */
  address?: string;
  /** Words found in the subject or the text, as written, in any case. */
  text?: string;
  direction?: 'received' | 'sent';
  limit?: number;
};

/** `%` and `_` in what the agent typed are text, not wildcards. */
const literal = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * This profile's mail, newest first. Only `profileId` scopes it: the log holds every profile's,
 * and the agent names nothing else that could reach another's.
 */
export async function searchEmail(db: Queryable, profileId: string, search: EmailSearch) {
  const where: SQL[] = [eq(emailLog.profileId, profileId)];
  const address = search.address?.trim().toLowerCase().replace(/^@/, '');
  if (address) {
    const exact = eq(emailLog.address, address);
    where.push(
      address.includes('@')
        ? exact
        : (or(
            like(emailLog.address, `%@${literal(address)}`),
            like(emailLog.address, `%.${literal(address)}`),
          ) as SQL),
    );
  }
  const words = search.text?.trim();
  if (words) {
    const pattern = `%${literal(words)}%`;
    where.push(or(ilike(emailLog.subject, pattern), ilike(emailLog.text, pattern)) as SQL);
  }
  if (search.direction) where.push(eq(emailLog.direction, search.direction));

  const rows = await db
    .select()
    .from(emailLog)
    .where(and(...where))
    .orderBy(desc(emailLog.createdAt))
    .limit(Math.min(Math.max(search.limit ?? 10, 1), SEARCH_LIMIT));

  return rows.map((row) => ({
    direction: row.direction,
    [row.direction === 'received' ? 'from' : 'to']: row.address,
    subject: row.subject,
    text: row.text.slice(0, SEARCH_TEXT_CHARS),
    ...(row.text.length > SEARCH_TEXT_CHARS ? { cut: true } : {}),
    at: row.createdAt.toISOString(),
  }));
}

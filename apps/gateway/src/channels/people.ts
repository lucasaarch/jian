import type { Person } from '@jian/contracts';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { contacts, messages, people } from '../storage/schema.js';

export type PersonRecord = {
  channelId: string;
  actorId: string;
  displayName?: string;
  avatar?: string;
  avatarCheckedAt?: string;
};

const toRecord = (row: typeof people.$inferSelect): PersonRecord => ({
  channelId: row.channelId,
  actorId: row.actorId,
  ...(row.displayName ? { displayName: row.displayName } : {}),
  ...(row.avatar ? { avatar: row.avatar } : {}),
  ...(row.avatarCheckedAt ? { avatarCheckedAt: row.avatarCheckedAt.toISOString() } : {}),
});

/** The name a member last wrote under wins; a message without one keeps the name already known. */
export async function rememberPerson(
  db: Queryable,
  person: { profileId: string; channelId: string; actorId: string; displayName?: string },
): Promise<void> {
  await db
    .insert(people)
    .values({ ...person, displayName: person.displayName ?? null })
    .onConflictDoUpdate({
      target: [people.channelId, people.actorId],
      set: {
        displayName: sql`coalesce(excluded.display_name, ${people.displayName})`,
        updatedAt: sql`now()`,
      },
    });
}

export async function findPerson(
  db: Queryable,
  channelId: string,
  actorId: string,
): Promise<PersonRecord | null> {
  const [row] = await db
    .select()
    .from(people)
    .where(and(eq(people.channelId, channelId), eq(people.actorId, actorId)))
    .limit(1);

  return row ? toRecord(row) : null;
}

/** Written apart from the name, so a message never erases a picture already fetched. */
export async function setPersonAvatar(
  db: Queryable,
  channelId: string,
  actorId: string,
  avatar: string | undefined,
  checkedAt: Date,
): Promise<void> {
  await db
    .update(people)
    .set({ ...(avatar ? { avatar } : {}), avatarCheckedAt: checkedAt })
    .where(and(eq(people.channelId, channelId), eq(people.actorId, actorId)));
}

/**
 * Everyone who wrote in one group conversation of this profile. The profile is a condition of
 * the read, so another profile's session lists nobody.
 */
export async function sessionPeople(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<PersonRecord[]> {
  const [contact] = await db
    .select({ channelId: contacts.channelId })
    .from(contacts)
    .where(and(eq(contacts.profileId, profileId), eq(contacts.sessionId, sessionId)))
    .limit(1);

  if (!contact) {
    return [];
  }

  const authors = db
    .selectDistinct({ id: messages.authorId })
    .from(messages)
    .where(
      and(
        eq(messages.profileId, profileId),
        eq(messages.sessionId, sessionId),
        isNotNull(messages.authorId),
      ),
    );
  const rows = await db
    .select()
    .from(people)
    .where(and(eq(people.channelId, contact.channelId), inArray(people.actorId, authors)));

  return rows.map(toRecord);
}

export const toPerson = (record: PersonRecord): Person => ({
  id: record.actorId,
  ...(record.displayName ? { name: record.displayName } : {}),
  ...(record.avatar ? { avatar: record.avatar } : {}),
});

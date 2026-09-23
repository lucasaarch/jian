import type { Profile } from '@jian/contracts';
import { profileRecordSchema } from '@jian/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { profileRevisions, profiles } from '../storage/schema.js';

type Row = typeof profiles.$inferSelect;

/** Columns come back as dates and the contract speaks ISO strings; the parse is the boundary. */
export function toProfile(row: Row): Profile {
  return profileRecordSchema.parse({
    ...row,
    avatar: row.avatar ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function toRow(profile: Profile): typeof profiles.$inferInsert {
  return {
    ...profile,
    createdAt: new Date(profile.createdAt),
    updatedAt: new Date(profile.updatedAt),
  };
}

export async function findProfile(db: Queryable, id: string): Promise<Profile | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.id, id)).limit(1);

  return row ? toProfile(row) : null;
}

export async function listProfiles(db: Queryable): Promise<Profile[]> {
  const rows = await db.select().from(profiles).orderBy(profiles.createdAt).limit(100);

  return rows.map(toProfile);
}

export async function insertProfile(db: Queryable, profile: Profile): Promise<void> {
  await db.insert(profiles).values(toRow(profile));
}

export async function updateProfileRow(db: Queryable, profile: Profile): Promise<void> {
  await db.update(profiles).set(toRow(profile)).where(eq(profiles.id, profile.id));
}

/** Every child row cascades from the foreign key; this is the one statement that removes them all. */
export async function deleteProfileRow(db: Queryable, id: string): Promise<void> {
  await db.delete(profiles).where(eq(profiles.id, id));
}

/** The whole document, so a run can read exactly the profile it froze. */
export async function insertRevision(db: Queryable, profile: Profile): Promise<void> {
  await db.insert(profileRevisions).values({
    profileId: profile.id,
    version: profile.version,
    document: profile,
    createdAt: new Date(profile.updatedAt),
  });
}

export async function findRevision(
  db: Queryable,
  profileId: string,
  version: number,
): Promise<Profile | null> {
  const [row] = await db
    .select()
    .from(profileRevisions)
    .where(and(eq(profileRevisions.profileId, profileId), eq(profileRevisions.version, version)))
    .limit(1);

  return row ? profileRecordSchema.parse(row.document) : null;
}

export async function listRevisions(db: Queryable, profileId: string) {
  const rows = await db
    .select()
    .from(profileRevisions)
    .where(eq(profileRevisions.profileId, profileId))
    .orderBy(desc(profileRevisions.version))
    .limit(50);

  return rows.map((row) => ({
    id: `${row.profileId}:${row.version}`,
    profileId: row.profileId,
    profile: profileRecordSchema.parse(row.document),
    createdAt: row.createdAt.toISOString(),
  }));
}

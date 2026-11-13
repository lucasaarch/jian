import type { Memory } from '@jian/contracts';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { memories, memoryLinks, memoryProjects, projects } from '../storage/schema.js';

type Row = typeof memories.$inferSelect;

/** The contract addresses a memory by one string; the table keys it by profile and key. */
export const memoryId = (profileId: string, key: string) => `${profileId}:${key}`;

function toMemory(row: Row): Memory {
  return {
    id: memoryId(row.profileId, row.key),
    profileId: row.profileId,
    key: row.key,
    content: row.content,
    version: row.version,
    ...(row.sourceSessionId ? { sourceSessionId: row.sourceSessionId } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMemories(
  db: Queryable,
  profileId: string,
  limit = 100,
): Promise<Memory[]> {
  const rows = await db
    .select()
    .from(memories)
    .where(eq(memories.profileId, profileId))
    .orderBy(desc(memories.updatedAt))
    .limit(limit);

  return rows.map(toMemory);
}

export async function findMemory(
  db: Queryable,
  profileId: string,
  key: string,
): Promise<Memory | null> {
  const [row] = await db
    .select()
    .from(memories)
    .where(and(eq(memories.profileId, profileId), eq(memories.key, key)))
    .limit(1);

  return row ? toMemory(row) : null;
}

/**
 * Whatever mentions any of the words. The vector repeats the `memories_search` expression
 * verbatim — a different one is a different expression, and Postgres then scans the table.
 * Each word becomes its own `plainto_tsquery`, OR-ed into one query, so a word carrying
 * tsquery punctuation is text to match rather than syntax to parse.
 */
export async function searchMemories(
  db: Queryable,
  profileId: string,
  words: string[],
  limit = 100,
): Promise<Memory[]> {
  if (words.length === 0) {
    return [];
  }

  const query = sql.join(
    words.map((word) => sql`plainto_tsquery('simple', ${word})`),
    sql` || `,
  );

  const rows = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.profileId, profileId),
        sql`to_tsvector('simple', ${memories.key} || ' ' || ${memories.content}) @@ (${query})`,
      ),
    )
    .orderBy(desc(memories.updatedAt))
    .limit(limit);

  return rows.map(toMemory);
}

/**
 * The write behind the version check. An absent key is an insert, which the primary key lets
 * happen once; a present one is updated only while it still carries the version that was read.
 * A race lost between the read and the write touches nothing and returns false, so the caller
 * reports the same conflict it would have reported from the read.
 */
export async function writeMemory(
  db: Queryable,
  memory: Memory,
  expectedVersion: number,
): Promise<boolean> {
  const values = {
    profileId: memory.profileId,
    key: memory.key,
    content: memory.content,
    version: memory.version,
    sourceSessionId: memory.sourceSessionId ?? null,
    updatedAt: new Date(memory.updatedAt),
  };

  const written = await db
    .insert(memories)
    .values(values)
    .onConflictDoUpdate({
      target: [memories.profileId, memories.key],
      set: {
        content: values.content,
        version: values.version,
        sourceSessionId: values.sourceSessionId,
        updatedAt: values.updatedAt,
      },
      setWhere: eq(memories.version, expectedVersion),
    })
    .returning({ key: memories.key });

  return written.length > 0;
}

export async function deleteMemory(db: Queryable, profileId: string, key: string): Promise<void> {
  await db.delete(memories).where(and(eq(memories.profileId, profileId), eq(memories.key, key)));
}

/** A link is stored once, the smaller key first: a to b and b to a are the same row. */
const pair = (a: string, b: string) => (a < b ? { aKey: a, bKey: b } : { aKey: b, bKey: a });

/** Each memory's linked keys, for the given keys, or for every memory of the profile. */
export async function linksOf(
  db: Queryable,
  profileId: string,
  keys?: string[],
): Promise<Map<string, string[]>> {
  const links = new Map<string, string[]>();

  if (keys && keys.length === 0) return links;

  const rows = await db
    .select({ aKey: memoryLinks.aKey, bKey: memoryLinks.bKey })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.profileId, profileId),
        keys ? or(inArray(memoryLinks.aKey, keys), inArray(memoryLinks.bKey, keys)) : undefined,
      ),
    );

  for (const { aKey, bKey } of rows) {
    links.set(aKey, [...(links.get(aKey) ?? []), bKey]);
    links.set(bKey, [...(links.get(bKey) ?? []), aKey]);
  }

  return links;
}

/** Each given memory's pinned project ids. */
async function projectsOf(
  db: Queryable,
  profileId: string,
  keys: string[],
): Promise<Map<string, string[]>> {
  const pinned = new Map<string, string[]>();

  if (keys.length === 0) return pinned;

  const rows = await db
    .select({ key: memoryProjects.memoryKey, projectId: memoryProjects.projectId })
    .from(memoryProjects)
    .where(and(eq(memoryProjects.profileId, profileId), inArray(memoryProjects.memoryKey, keys)));

  for (const { key, projectId } of rows) pinned.set(key, [...(pinned.get(key) ?? []), projectId]);

  return pinned;
}

/** The memories with the keys they are linked to and the projects they are pinned to. */
export async function withLinks(
  db: Queryable,
  profileId: string,
  list: Memory[],
): Promise<Memory[]> {
  const keys = list.map((memory) => memory.key);
  const [links, pinned] = await Promise.all([
    linksOf(db, profileId, keys),
    projectsOf(db, profileId, keys),
  ]);

  return list.map((memory) => ({
    ...memory,
    links: (links.get(memory.key) ?? []).sort(),
    projectIds: (pinned.get(memory.key) ?? []).sort(),
  }));
}

/** How many of these ids are projects of this profile. */
export async function countProjects(
  db: Queryable,
  profileId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;

  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.profileId, profileId), inArray(projects.id, ids)));

  return rows.length;
}

/** Makes the pinned projects of one memory exactly `ids`. */
export async function setProjects(
  db: Queryable,
  profileId: string,
  key: string,
  ids: string[],
): Promise<void> {
  await db
    .delete(memoryProjects)
    .where(and(eq(memoryProjects.profileId, profileId), eq(memoryProjects.memoryKey, key)));

  if (ids.length > 0) {
    await db
      .insert(memoryProjects)
      .values(ids.map((projectId) => ({ profileId, memoryKey: key, projectId })));
  }
}

/** The memories pinned to a project, newest first. */
export async function memoriesOfProject(
  db: Queryable,
  profileId: string,
  projectId: string,
  limit = 10,
): Promise<Memory[]> {
  const rows = await db
    .select({ memory: memories })
    .from(memoryProjects)
    .innerJoin(
      memories,
      and(
        eq(memories.profileId, memoryProjects.profileId),
        eq(memories.key, memoryProjects.memoryKey),
      ),
    )
    .where(and(eq(memoryProjects.profileId, profileId), eq(memoryProjects.projectId, projectId)))
    .orderBy(desc(memories.updatedAt))
    .limit(limit);

  return rows.map(({ memory }) => toMemory(memory));
}

export async function findMemories(
  db: Queryable,
  profileId: string,
  keys: string[],
): Promise<Memory[]> {
  if (keys.length === 0) return [];

  const rows = await db
    .select()
    .from(memories)
    .where(and(eq(memories.profileId, profileId), inArray(memories.key, keys)));

  return rows.map(toMemory);
}

export async function addLink(db: Queryable, profileId: string, a: string, b: string) {
  await db
    .insert(memoryLinks)
    .values({ profileId, ...pair(a, b) })
    .onConflictDoNothing();
}

export async function removeLink(db: Queryable, profileId: string, a: string, b: string) {
  const { aKey, bKey } = pair(a, b);

  await db
    .delete(memoryLinks)
    .where(
      and(
        eq(memoryLinks.profileId, profileId),
        eq(memoryLinks.aKey, aKey),
        eq(memoryLinks.bKey, bKey),
      ),
    );
}

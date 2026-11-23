import { randomUUID } from 'node:crypto';
import {
  type ArtifactFolder,
  type ArtifactFolders,
  artifactFolderInputSchema,
} from '@jian/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { assertFound } from '../core/errors.js';
import { findProfile } from '../profiles/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import { artifactFolders, projects, sessionArtifacts, sessions } from '../storage/schema.js';

/*
 * The folders of the owner's page of Artifacts. Every Artifact starts under the project of the
 * conversation it was made in, which is no row anywhere; a folder here is one the owner made to
 * move some into. Each is one profile's, and every read and write names that profile.
 */

/**
 * The project an Artifact is kept under until it is moved: its conversation's, or, once that
 * conversation is deleted, the one it was in then. Read with `sessions` left joined on the
 * Artifact's conversation, which may be gone.
 */
export const artifactProject = sql<
  string | null
>`coalesce(${sessions.projectId}, ${sessionArtifacts.projectId})`;

/**
 * Before conversations are deleted: their Artifacts stay, and note the project each conversation
 * was in, where the owner's page goes on keeping them. `sessionId` is the one conversation
 * going; absent, every conversation of the profile is. One already gone keeps what it noted.
 */
export async function keepArtifactsOf(db: Queryable, profileId: string, sessionId?: string) {
  await db
    .update(sessionArtifacts)
    .set({ projectId: sql`${sessions.projectId}` })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionArtifacts.sessionId),
        eq(sessionArtifacts.profileId, profileId),
        ...(sessionId ? [eq(sessions.id, sessionId)] : []),
      ),
    );
}

const folderOf = (row: typeof artifactFolders.$inferSelect, artifacts: number): ArtifactFolder => ({
  id: row.id,
  name: row.name,
  artifacts,
  createdAt: row.createdAt.toISOString(),
});

/** The folder, if it is this profile's: what an Artifact is moved to must be. */
export async function ownFolder(reader: Queryable, profileId: string, folderId: string) {
  const [row] = await reader
    .select()
    .from(artifactFolders)
    .where(and(eq(artifactFolders.id, folderId), eq(artifactFolders.profileId, profileId)))
    .limit(1);

  return assertFound(row, 'Folder');
}

/**
 * The owner's folders by name, each with how many it holds, and the projects that still hold an
 * Artifact nobody moved, the conversations in no project last.
 */
export async function listFolders(db: Queryable, profileId: string): Promise<ArtifactFolders> {
  assertFound(await findProfile(db, profileId), 'Profile');
  const made = await db
    .select({
      folder: artifactFolders,
      artifacts: sql<number>`count(${sessionArtifacts.id})::int`,
    })
    .from(artifactFolders)
    .leftJoin(sessionArtifacts, eq(sessionArtifacts.folderId, artifactFolders.id))
    .where(eq(artifactFolders.profileId, profileId))
    .groupBy(artifactFolders.id)
    .orderBy(asc(sql`lower(${artifactFolders.name})`), asc(artifactFolders.createdAt));
  const started = await db
    .select({
      projectId: artifactProject,
      name: projects.name,
      artifacts: sql<number>`count(*)::int`,
    })
    .from(sessionArtifacts)
    .leftJoin(sessions, eq(sessions.id, sessionArtifacts.sessionId))
    .leftJoin(projects, eq(projects.id, artifactProject))
    .where(and(eq(sessionArtifacts.profileId, profileId), isNull(sessionArtifacts.folderId)))
    .groupBy(artifactProject, projects.name)
    // A null sorts last, which is where the conversations in no project belong.
    .orderBy(asc(sql`lower(${projects.name})`));

  return { folders: made.map((row) => folderOf(row.folder, row.artifacts)), projects: started };
}

export async function createFolder(
  store: Store,
  clock: Clock,
  profileId: string,
  input: unknown,
): Promise<ArtifactFolder> {
  const { name } = artifactFolderInputSchema.parse(input);
  assertFound(await findProfile(store.db, profileId), 'Profile');

  return store.transaction(profileId, async (tx) => {
    const [row] = await tx
      .insert(artifactFolders)
      .values({ id: randomUUID(), profileId, name, createdAt: new Date(clock()) })
      .returning();

    return folderOf(assertFound(row, 'Folder'), 0);
  });
}

export async function renameFolder(
  store: Store,
  profileId: string,
  folderId: string,
  input: unknown,
): Promise<ArtifactFolder> {
  const { name } = artifactFolderInputSchema.parse(input);

  return store.transaction(profileId, async (tx) => {
    const current = await ownFolder(tx, profileId, folderId);
    const [row] = await tx
      .update(artifactFolders)
      .set({ name })
      .where(eq(artifactFolders.id, current.id))
      .returning();
    const [held] = await tx
      .select({ artifacts: sql<number>`count(*)::int` })
      .from(sessionArtifacts)
      .where(eq(sessionArtifacts.folderId, current.id));

    return folderOf(assertFound(row, 'Folder'), held?.artifacts ?? 0);
  });
}

/**
 * Only the folder goes. What it held is left in no folder by the database itself, which is back
 * under the project of its conversation: no Artifact is ever deleted with a folder.
 */
export async function deleteFolder(store: Store, profileId: string, folderId: string) {
  await store.transaction(profileId, async (tx) => {
    const current = await ownFolder(tx, profileId, folderId);
    await tx.delete(artifactFolders).where(eq(artifactFolders.id, current.id));
  });
}

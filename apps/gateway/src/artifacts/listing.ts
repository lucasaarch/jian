import { NO_PROJECT, type SessionArtifactType } from '@jian/contracts';
import { and, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { assertFound } from '../core/errors.js';
import type { Queryable } from '../storage/database.js';
import { sessionArtifacts, sessions } from '../storage/schema.js';

/**
 * Every Artifact of a profile, across its conversations, the one changed last first, a page at
 * a time: what the panel's Artifacts page lists. Each comes with the stored title and the project
 * of its conversation.
 *
 * `folder` narrows it to one folder of the owner's, and `project` to what nobody moved out of a
 * project's conversations (`none`: of those in no project), which is where each one starts.
 *
 * `before` is the id of the last Artifact already read. One that is gone by then, deleted
 * between two pages, is refused rather than answered from the start again.
 */
export async function pageProfileArtifacts(
  db: Queryable,
  where: {
    profileId: string;
    before?: string | undefined;
    q?: string | undefined;
    type?: SessionArtifactType | undefined;
    folder?: string | undefined;
    project?: string | undefined;
    pinned?: 'true' | 'false' | undefined;
    limit: number;
  },
) {
  const conditions = [eq(sessionArtifacts.profileId, where.profileId)];

  // To the owner a Mermaid diagram and a diagram are one kind, so asking for one finds both.
  if (where.type === 'diagram') {
    conditions.push(inArray(sessionArtifacts.type, ['diagram', 'mermaid']));
  } else if (where.type) {
    conditions.push(eq(sessionArtifacts.type, where.type));
  }
  if (where.pinned) conditions.push(eq(sessionArtifacts.pinned, where.pinned === 'true'));
  if (where.folder) conditions.push(eq(sessionArtifacts.folderId, where.folder));
  if (where.project) {
    conditions.push(
      isNull(sessionArtifacts.folderId),
      where.project === NO_PROJECT
        ? isNull(sessions.projectId)
        : eq(sessions.projectId, where.project),
    );
  }
  // The words as typed: `%` and `_` are a title's own characters here, not a pattern's.
  if (where.q) {
    conditions.push(ilike(sessionArtifacts.title, `%${where.q.replace(/[\\%_]/g, '\\$&')}%`));
  }
  if (where.before) {
    const [cursor] = await db
      .select({ id: sessionArtifacts.id })
      .from(sessionArtifacts)
      .where(
        and(eq(sessionArtifacts.id, where.before), eq(sessionArtifacts.profileId, where.profileId)),
      )
      .limit(1);
    assertFound(cursor, 'Artifact cursor');
    // Compared inside the database, where a time keeps the precision it was stored with.
    conditions.push(
      sql`(${sessionArtifacts.updatedAt}, ${sessionArtifacts.id}) < (select "updated_at", "id" from "session_artifacts" where "id" = ${where.before})`,
    );
  }
  const rows = await db
    .select({
      artifact: sessionArtifacts,
      sessionTitle: sessions.title,
      projectId: sessions.projectId,
    })
    .from(sessionArtifacts)
    .innerJoin(sessions, eq(sessions.id, sessionArtifacts.sessionId))
    .where(and(...conditions))
    .orderBy(desc(sessionArtifacts.updatedAt), desc(sessionArtifacts.id))
    .limit(where.limit + 1);
  const items = rows.slice(0, where.limit);

  return {
    items,
    nextCursor: rows.length > where.limit ? (items.at(-1)?.artifact.id ?? null) : null,
  };
}

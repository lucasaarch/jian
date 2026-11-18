import { randomBytes, randomUUID } from 'node:crypto';
import {
  type SessionArtifact,
  type SessionArtifactType,
  type SessionArtifactVersion,
  sessionArtifactCreateSchema,
  sessionArtifactRevisionSchema,
  sessionArtifactUpdateSchema,
} from '@jian/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { transform } from 'sucrase';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { SessionReader } from '../sessions/port.js';
import type { Queryable, Store } from '../storage/database.js';
import { sessionArtifacts, sessionArtifactVersions } from '../storage/schema.js';

/** What a component's frame can hand it; anything else would have to come from the network. */
const IMPORTABLE = new Set(['react', 'react-dom', 'react-dom/client']);

/**
 * A React component as the script its frame runs: JSX and types gone, imports as `require`. It
 * is made again on each read and never stored, so the source stays the one thing kept.
 */
function compiled(content: string): string {
  let code: string;

  try {
    code = transform(content, {
      transforms: ['jsx', 'typescript', 'imports'],
      production: true,
    }).code;
  } catch (error) {
    throw new GatewayError(
      400,
      `The component does not compile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const foreign = [...code.matchAll(/\brequire\((['"])(.+?)\1\)/g)]
    .map((match) => match[2] as string)
    .find((name) => !IMPORTABLE.has(name));
  if (foreign) {
    throw new GatewayError(
      400,
      `A component can import only react and react-dom, not "${foreign}". Write what it needs in the component itself.`,
    );
  }
  if (!/\bexports\.default\b/.test(code)) {
    throw new GatewayError(400, 'The component must be the default export of its source.');
  }

  return code;
}

/** What a frame is handed for a type: the source itself, but a component compiled. */
const drawn = (type: SessionArtifactType, content: string) =>
  type === 'react' ? compiled(content) : content;

const recordOf = (row: typeof sessionArtifacts.$inferSelect): SessionArtifact => ({
  id: row.id,
  sessionId: row.sessionId,
  title: row.title,
  type: row.type,
  visibility: row.visibility,
  version: row.version,
  publicPath:
    row.visibility === 'public' && row.publicToken
      ? `/v1/public-artifacts/${row.publicToken}`
      : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * What an agent made for the owner to see drawn beside a conversation, with every version it had.
 * Each belongs to the conversation it was made in, and is read and changed only through it.
 */
export class SessionArtifacts {
  constructor(
    private readonly store: Store,
    private readonly sessions: SessionReader,
    private readonly clock: Clock = Date.now,
    /**
     * A desktop app's own gateway: no link reaches it from outside, so nothing there is made
     * public, and nothing that arrived public in its data is served.
     */
    private readonly local = false,
  ) {}

  private async find(reader: Queryable, profileId: string, sessionId: string, id: string) {
    const [row] = await reader
      .select()
      .from(sessionArtifacts)
      .where(
        and(
          eq(sessionArtifacts.id, id),
          eq(sessionArtifacts.profileId, profileId),
          eq(sessionArtifacts.sessionId, sessionId),
        ),
      )
      .limit(1);

    return assertFound(row, 'Artifact');
  }

  /** Tells the panel showing this conversation to bring the Artifact forward, as it now is. */
  private shown(tx: Queryable, profileId: string, sessionId: string, artifactId: string) {
    return recordEvent(tx, this.clock, profileId, 'conversation.inspector.focus', {
      sessionId,
      kind: 'artifact',
      artifactId,
    });
  }

  async create(profileId: string, sessionId: string, input: unknown): Promise<SessionArtifact> {
    const data = sessionArtifactCreateSchema.parse(input);
    // Refused here, where the agent can still fix it, rather than drawn broken for the owner.
    drawn(data.type, data.content);
    await this.sessions.session(profileId, sessionId);
    const now = new Date(this.clock());

    return this.store.transaction(profileId, async (tx) => {
      const [row] = await tx
        .insert(sessionArtifacts)
        .values({
          id: randomUUID(),
          profileId,
          sessionId,
          title: data.title,
          type: data.type,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const made = assertFound(row, 'Artifact');
      await tx
        .insert(sessionArtifactVersions)
        .values({ artifactId: made.id, version: 1, content: data.content, createdAt: now });
      await this.shown(tx, profileId, sessionId, made.id);

      return recordOf(made);
    });
  }

  /** A new version beside the ones it had: none is ever changed or removed. */
  async revise(profileId: string, sessionId: string, input: unknown): Promise<SessionArtifact> {
    const data = sessionArtifactRevisionSchema.parse(input);
    const now = new Date(this.clock());

    return this.store.transaction(profileId, async (tx) => {
      const current = await this.find(tx, profileId, sessionId, data.artifactId);
      drawn(current.type, data.content);
      const [row] = await tx
        .update(sessionArtifacts)
        .set({
          version: sql`${sessionArtifacts.version} + 1`,
          updatedAt: now,
          ...(data.title ? { title: data.title } : {}),
        })
        .where(eq(sessionArtifacts.id, current.id))
        .returning();
      const revised = assertFound(row, 'Artifact');
      await tx.insert(sessionArtifactVersions).values({
        artifactId: revised.id,
        version: revised.version,
        content: data.content,
        createdAt: now,
      });
      await this.shown(tx, profileId, sessionId, revised.id);

      return recordOf(revised);
    });
  }

  /** The conversation's Artifacts, the one changed last first. */
  async list(profileId: string, sessionId: string): Promise<SessionArtifact[]> {
    await this.sessions.session(profileId, sessionId);
    const rows = await this.store.db
      .select()
      .from(sessionArtifacts)
      .where(
        and(eq(sessionArtifacts.profileId, profileId), eq(sessionArtifacts.sessionId, sessionId)),
      )
      .orderBy(desc(sessionArtifacts.updatedAt));

    return rows.map(recordOf);
  }

  async version(
    profileId: string,
    sessionId: string,
    artifactId: string,
    version: number,
  ): Promise<SessionArtifactVersion> {
    const artifact = await this.find(this.store.db, profileId, sessionId, artifactId);
    const [row] = await this.store.db
      .select()
      .from(sessionArtifactVersions)
      .where(
        and(
          eq(sessionArtifactVersions.artifactId, artifact.id),
          eq(sessionArtifactVersions.version, version),
        ),
      )
      .limit(1);
    const found = assertFound(row, 'Artifact version');

    return {
      artifactId: artifact.id,
      version: found.version,
      content: found.content,
      ...(artifact.type === 'react' ? { compiled: compiled(found.content) } : {}),
      createdAt: found.createdAt.toISOString(),
    };
  }

  /**
   * Public gives it a link made of a new secret; private takes the link away, and making it
   * public again gives another, so a link that was once shared never comes back to life.
   */
  async setVisibility(
    profileId: string,
    sessionId: string,
    artifactId: string,
    input: unknown,
  ): Promise<SessionArtifact> {
    const { visibility } = sessionArtifactUpdateSchema.parse(input);

    if (visibility === 'public' && this.local) {
      throw new GatewayError(
        409,
        'An Artifact can be made public only on a server gateway. This one runs inside the desktop app, where no link from outside reaches it.',
      );
    }

    return this.store.transaction(profileId, async (tx) => {
      const current = await this.find(tx, profileId, sessionId, artifactId);
      if (current.visibility === visibility) return recordOf(current);
      const [row] = await tx
        .update(sessionArtifacts)
        .set({
          visibility,
          publicToken: visibility === 'public' ? randomBytes(32).toString('base64url') : null,
        })
        .where(eq(sessionArtifacts.id, current.id))
        .returning();

      return recordOf(assertFound(row, 'Artifact'));
    });
  }

  /**
   * What a link answers: the latest version of the one Artifact that holds this secret while it
   * is public, and nothing of the conversation, the profile or any other version.
   */
  async published(
    token: string,
  ): Promise<{ type: SessionArtifactType; title: string; source: string }> {
    const [row] = this.local
      ? []
      : await this.store.db
          .select({
            type: sessionArtifacts.type,
            title: sessionArtifacts.title,
            content: sessionArtifactVersions.content,
          })
          .from(sessionArtifacts)
          .innerJoin(
            sessionArtifactVersions,
            and(
              eq(sessionArtifactVersions.artifactId, sessionArtifacts.id),
              eq(sessionArtifactVersions.version, sessionArtifacts.version),
            ),
          )
          .where(
            and(eq(sessionArtifacts.publicToken, token), eq(sessionArtifacts.visibility, 'public')),
          )
          .limit(1);
    const found = assertFound(row, 'Artifact');

    return { type: found.type, title: found.title, source: drawn(found.type, found.content) };
  }
}

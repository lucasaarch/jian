import { randomBytes, randomUUID } from 'node:crypto';
import {
  type ArtifactFolder,
  type ArtifactFolders,
  boardContentSchema,
  type DeckExport,
  deckExportQuerySchema,
  deckSlideAddSchema,
  deckSlideDeleteSchema,
  deckSlideMoveSchema,
  deckSlideUpdateSchema,
  EDITABLE_ARTIFACT_TYPES,
  type ProfileArtifact,
  profileArtifactsQuerySchema,
  type SessionArtifact,
  type SessionArtifactAuthor,
  type SessionArtifactType,
  type SessionArtifactVersion,
  sessionArtifactCreateSchema,
  sessionArtifactEditSchema,
  sessionArtifactReadSchema,
  sessionArtifactRevisionSchema,
  sessionArtifactUpdateSchema,
} from '@jian/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { transform } from 'sucrase';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { findProfile } from '../profiles/repository.js';
import type { SessionReader } from '../sessions/port.js';
import type { Queryable, Store } from '../storage/database.js';
import { sessionArtifacts, sessionArtifactVersions } from '../storage/schema.js';
import { changedSlides, deckContent, type SlideChange, slidesOf } from './deck.js';
import { exportDeck } from './export.js';
import { createFolder, deleteFolder, listFolders, ownFolder, renameFolder } from './folders.js';
import { pageProfileArtifacts } from './listing.js';

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

/**
 * A whiteboard is data its frame draws, not code: checked against its form, so a mistake is the
 * agent's to fix now rather than a board that will not draw.
 */
function checkBoard(content: string): void {
  let given: unknown;
  try {
    given = JSON.parse(content);
  } catch {
    throw new GatewayError(400, 'A whiteboard is given as JSON: {"items": [ … ]}.');
  }
  const checked = boardContentSchema.safeParse(given);
  const issue = checked.error?.issues[0];
  if (issue) {
    throw new GatewayError(
      400,
      `The whiteboard does not fit its form at ${issue.path.join('.') || 'its top'}: ${issue.message}`,
    );
  }
}

/** What the agent gives for a version: which of these it takes depends on the type. */
type Given = {
  content?: string | undefined;
  slides?: string[] | undefined;
};

/**
 * What a version keeps for what the agent gave: a deck its slides, any other type its source.
 * Refused here, where the agent can still fix it, rather than drawn broken for the owner.
 */
function kept(type: SessionArtifactType, given: Given): string {
  if (type === 'deck') {
    if (!given.slides || given.content !== undefined) {
      throw new GatewayError(
        400,
        'A deck is given as `slides`, each a whole HTML page, and takes no `content`.',
      );
    }
    return deckContent(given.slides);
  }
  if (given.content === undefined || given.slides) {
    throw new GatewayError(
      400,
      `A ${type} Artifact is given as \`content\`. Only a deck takes \`slides\`.`,
    );
  }
  drawn(type, given.content);
  if (type === 'board') checkBoard(given.content);

  return given.content;
}

/** What the owner's copy of an Artifact is called after the one it was made from. */
const COPY = ' (copy)';

/** The input each slide tool takes, by what it does to the deck. */
const SLIDE_INPUT = {
  add: deckSlideAddSchema,
  update: deckSlideUpdateSchema,
  delete: deckSlideDeleteSchema,
  move: deckSlideMoveSchema,
};

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

  /**
   * `lock` holds the Artifact until the transaction ends. A version made from the one before it,
   * as a deck's is when one slide changes, needs it: two changes at once would otherwise each
   * start from the same slides, and the later would undo the earlier.
   */
  private async find(
    reader: Queryable,
    profileId: string,
    sessionId: string,
    id: string,
    lock = false,
  ) {
    const query = reader
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
    const [row] = await (lock ? query.for('update') : query);

    return assertFound(row, 'Artifact');
  }

  private async stored(reader: Queryable, artifactId: string, version: number) {
    const [row] = await reader
      .select()
      .from(sessionArtifactVersions)
      .where(
        and(
          eq(sessionArtifactVersions.artifactId, artifactId),
          eq(sessionArtifactVersions.version, version),
        ),
      )
      .limit(1);

    return assertFound(row, 'Artifact version');
  }

  /** A new version beside the ones it had: none is ever changed or removed. */
  private async versioned(
    tx: Queryable,
    current: typeof sessionArtifacts.$inferSelect,
    content: string,
    author: SessionArtifactAuthor,
    title?: string,
  ): Promise<SessionArtifact> {
    const now = new Date(this.clock());
    const [row] = await tx
      .update(sessionArtifacts)
      .set({
        version: sql`${sessionArtifacts.version} + 1`,
        updatedAt: now,
        ...(title ? { title } : {}),
      })
      .where(eq(sessionArtifacts.id, current.id))
      .returning();
    const revised = assertFound(row, 'Artifact');
    await tx.insert(sessionArtifactVersions).values({
      artifactId: revised.id,
      version: revised.version,
      content,
      author,
      createdAt: now,
    });

    return recordOf(revised);
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
    // Before anything is read or kept: a source that cannot be drawn costs no transaction.
    const content = kept(data.type, data);
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
        .values({ artifactId: made.id, version: 1, content, createdAt: now });
      await this.shown(tx, profileId, sessionId, made.id);

      return recordOf(made);
    });
  }

  /** The agent's new version of one: the whole content again, or every slide of a deck. */
  async revise(profileId: string, sessionId: string, input: unknown): Promise<SessionArtifact> {
    const data = sessionArtifactRevisionSchema.parse(input);

    return this.store.transaction(profileId, async (tx) => {
      const current = await this.find(tx, profileId, sessionId, data.artifactId);
      const revised = await this.versioned(
        tx,
        current,
        kept(current.type, data),
        'agent',
        data.title,
      );
      await this.shown(tx, profileId, sessionId, revised.id);

      return revised;
    });
  }

  /**
   * The agent's change to one slide of a deck, or to where one stands: a new version holding
   * every slide, made from the latest. Answers how many slides the deck then has.
   */
  async changeSlide(
    profileId: string,
    sessionId: string,
    op: keyof typeof SLIDE_INPUT,
    input: unknown,
  ): Promise<SessionArtifact & { slides: number }> {
    const { artifactId, ...change } = SLIDE_INPUT[op].parse(input);

    return this.store.transaction(profileId, async (tx) => {
      const current = await this.find(tx, profileId, sessionId, artifactId, true);
      if (current.type !== 'deck') {
        throw new GatewayError(
          400,
          `Only a deck has slides, and this Artifact is ${current.type}. Give it a new version with update_artifact.`,
        );
      }
      const latest = await this.stored(tx, current.id, current.version);
      const slides = changedSlides(slidesOf(latest.content), { op, ...change } as SlideChange);
      const revised = await this.versioned(tx, current, deckContent(slides), 'agent');
      await this.shown(tx, profileId, sessionId, revised.id);

      return { ...revised, slides: slides.length };
    });
  }

  /**
   * What the owner saved after editing one by hand in the panel: a new version of theirs, made
   * from the version they were editing. A source is checked as the agent's is and kept as it
   * came; a deck gets that one slide.
   * The panel that saved it already shows it, so nothing is told to bring it forward.
   */
  async edit(
    profileId: string,
    sessionId: string,
    artifactId: string,
    input: unknown,
  ): Promise<SessionArtifact> {
    const data = sessionArtifactEditSchema.parse(input);

    return this.store.transaction(profileId, async (tx) => {
      const current = await this.find(tx, profileId, sessionId, artifactId, true);
      if (!EDITABLE_ARTIFACT_TYPES.includes(current.type)) {
        throw new GatewayError(
          409,
          'This kind of Artifact is not edited by hand. Ask the agent for a new version of it.',
        );
      }
      const edited = await this.stored(tx, current.id, data.version);
      if (current.type !== 'deck') {
        if (data.slide !== undefined) throw new GatewayError(400, 'Only a deck has slides.');
        return this.versioned(tx, current, kept(current.type, { content: data.content }), 'owner');
      }
      if (data.slide === undefined) {
        throw new GatewayError(400, 'Say which slide of the deck was edited.');
      }
      const slides = changedSlides(slidesOf(edited.content), {
        op: 'update',
        slide: data.slide,
        html: data.content,
      });

      return this.versioned(tx, current, deckContent(slides), 'owner');
    });
  }

  /**
   * What the agent reads back before changing one: the source of a version, the latest unless
   * another is named, and who wrote it, since the owner may have edited it by hand since.
   */
  async read(profileId: string, sessionId: string, input: unknown) {
    const data = sessionArtifactReadSchema.parse(input);
    const artifact = await this.find(this.store.db, profileId, sessionId, data.artifactId);
    const found = await this.stored(this.store.db, artifact.id, data.version ?? artifact.version);
    const about = {
      artifactId: artifact.id,
      title: artifact.title,
      type: artifact.type,
      version: found.version,
      latestVersion: artifact.version,
      writtenBy: found.author,
    };

    if (artifact.type !== 'deck') {
      if (data.slide !== undefined) {
        throw new GatewayError(
          400,
          `Only a deck has slides, and this Artifact is ${artifact.type}.`,
        );
      }
      return { ...about, content: found.content };
    }
    const slides = slidesOf(found.content).map((html, index) => ({ slide: index + 1, html }));
    if (data.slide === undefined) return { ...about, slides };
    const one = slides[data.slide - 1];
    if (!one) {
      throw new GatewayError(
        400,
        `The deck has ${slides.length} slides, so there is no slide ${data.slide}.`,
      );
    }

    return { ...about, slideCount: slides.length, ...one };
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

    return rows.map((row) => recordOf(row));
  }

  /** Every Artifact of the profile, whatever conversation it was made in (listing.ts). */
  async listAll(
    profileId: string,
    input: unknown,
  ): Promise<{ items: ProfileArtifact[]; nextCursor: string | null }> {
    const query = profileArtifactsQuerySchema.parse(input);
    assertFound(await findProfile(this.store.db, profileId), 'Profile');
    const page = await pageProfileArtifacts(this.store.db, { profileId, ...query });

    return {
      items: page.items.map((row) => ({
        ...recordOf(row.artifact),
        sessionTitle: row.sessionTitle,
        projectId: row.projectId,
        pinned: row.artifact.pinned,
        folderId: row.artifact.folderId,
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * The owner's removal of one, for good: its versions go with it in the database, and its
   * public link answers nothing from then on.
   */
  async delete(profileId: string, sessionId: string, artifactId: string): Promise<void> {
    await this.store.transaction(profileId, async (tx) => {
      const current = await this.find(tx, profileId, sessionId, artifactId, true);
      await tx.delete(sessionArtifacts).where(eq(sessionArtifacts.id, current.id));
    });
  }

  async version(
    profileId: string,
    sessionId: string,
    artifactId: string,
    version: number,
  ): Promise<SessionArtifactVersion> {
    const artifact = await this.find(this.store.db, profileId, sessionId, artifactId);
    const found = await this.stored(this.store.db, artifact.id, version);

    return {
      artifactId: artifact.id,
      version: found.version,
      author: found.author,
      content: found.content,
      ...(artifact.type === 'react' ? { compiled: compiled(found.content) } : {}),
      ...(artifact.type === 'deck' ? { slides: slidesOf(found.content) } : {}),
      createdAt: found.createdAt.toISOString(),
    };
  }

  /**
   * A deck's version as a file to keep, drawn by the gateway's browser (export.ts): a PDF or a
   * PowerPoint file of every slide, or one slide as a picture. It reads and changes nothing.
   * Whatever can be refused is refused before a browser is started.
   */
  async export(
    profileId: string,
    sessionId: string,
    artifactId: string,
    version: number,
    input: unknown,
  ): Promise<DeckExport> {
    const wanted = deckExportQuerySchema.parse(input);
    const artifact = await this.find(this.store.db, profileId, sessionId, artifactId);

    if (artifact.type !== 'deck') {
      throw new GatewayError(400, 'Only a deck is exported as slides.');
    }
    if (this.local) {
      throw new GatewayError(
        409,
        'A deck is drawn for a PDF, a picture or PowerPoint only on a server gateway. This one runs inside the desktop app, which has no browser of its own to draw with.',
      );
    }
    const slides = slidesOf((await this.stored(this.store.db, artifact.id, version)).content);
    let drawn: readonly string[] = slides;

    if (wanted.format === 'png') {
      const slide = wanted.slide === undefined ? undefined : slides[wanted.slide - 1];
      if (slide === undefined) {
        throw new GatewayError(
          400,
          wanted.slide === undefined
            ? 'A picture is of one slide: say which, counting from 1.'
            : `The deck has ${slides.length} ${slides.length === 1 ? 'slide' : 'slides'}, so there is no slide ${wanted.slide}.`,
        );
      }
      drawn = [slide];
    }
    const file = await exportDeck(artifact.title, drawn, wanted);

    return { mimeType: file.mimeType, data: file.data.toString('base64') };
  }

  /**
   * The owner's copy of one, in the same conversation and the same folder: private, unpinned,
   * and starting again at version 1 with the latest content, whoever wrote it.
   */
  async duplicate(
    profileId: string,
    sessionId: string,
    artifactId: string,
  ): Promise<SessionArtifact> {
    const now = new Date(this.clock());

    return this.store.transaction(profileId, async (tx) => {
      const current = await this.find(tx, profileId, sessionId, artifactId);
      const latest = await this.stored(tx, current.id, current.version);
      const [row] = await tx
        .insert(sessionArtifacts)
        .values({
          id: randomUUID(),
          profileId,
          sessionId,
          // A title is at most 120 characters, the copy's too.
          title: `${current.title.slice(0, 120 - COPY.length)}${COPY}`,
          type: current.type,
          folderId: current.folderId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const made = assertFound(row, 'Artifact');
      await tx.insert(sessionArtifactVersions).values({
        artifactId: made.id,
        version: 1,
        content: latest.content,
        author: latest.author,
        createdAt: now,
      });

      return recordOf(made);
    });
  }

  /** Where the owner keeps this profile's Artifacts on their page of them (folders.ts). */
  folders(profileId: string): Promise<ArtifactFolders> {
    return listFolders(this.store.db, profileId);
  }

  createFolder(profileId: string, input: unknown): Promise<ArtifactFolder> {
    return createFolder(this.store, this.clock, profileId, input);
  }

  renameFolder(profileId: string, folderId: string, input: unknown): Promise<ArtifactFolder> {
    return renameFolder(this.store, profileId, folderId, input);
  }

  deleteFolder(profileId: string, folderId: string): Promise<void> {
    return deleteFolder(this.store, profileId, folderId);
  }

  /**
   * What the owner changes of one with no new version: who reads it, its name, its pin and its
   * folder. None of them is a change to what it is, so it keeps its place in the list.
   *
   * Public gives it a link made of a new secret; private takes the link away, and making it
   * public again gives another, so a link that was once shared never comes back to life.
   */
  async update(
    profileId: string,
    sessionId: string,
    artifactId: string,
    input: unknown,
  ): Promise<SessionArtifact> {
    const { visibility, title, pinned, folderId } = sessionArtifactUpdateSchema.parse(input);

    if (visibility === 'public' && this.local) {
      throw new GatewayError(
        409,
        'An Artifact can be made public only on a server gateway. This one runs inside the desktop app, where no link from outside reaches it.',
      );
    }

    return this.store.transaction(profileId, async (tx) => {
      const current = await this.find(tx, profileId, sessionId, artifactId);
      // Only a folder of the same profile: another agent's is not found.
      if (folderId) await ownFolder(tx, profileId, folderId);
      const change = {
        ...(visibility !== undefined && visibility !== current.visibility
          ? {
              visibility,
              publicToken: visibility === 'public' ? randomBytes(32).toString('base64url') : null,
            }
          : {}),
        ...(title !== undefined ? { title } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
      };
      if (Object.keys(change).length === 0) return recordOf(current);
      const [row] = await tx
        .update(sessionArtifacts)
        .set(change)
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

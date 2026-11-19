import { z } from 'zod';

/**
 * An Artifact: something the agent made for the owner to see drawn beside the conversation, kept
 * with every version it had. Not a stored tool result, which `artifactSchema` is.
 */

/** The most one version holds, in characters; for a deck, the most one slide holds. */
export const SESSION_ARTIFACT_MAX = 400_000;

/** The most slides one deck holds. */
export const DECK_SLIDES_MAX = 100;

/** The most a deck's slides hold together, in characters: what one version of it stores. */
export const DECK_MAX = 2_000_000;

/** A slide's canvas, in CSS pixels. It is drawn at this size and scaled to where it is shown. */
export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;

/**
 * What it is drawn as: a whole page, one React component, a Markdown document, a Mermaid
 * diagram, a deck (a set of slides, each a page of its own; the panel names it Slide), or a
 * spreadsheet (CSV, whose cells may hold formulas). Always a source the agent
 * wrote, never a file as it was: a file it made is sent as a file.
 */
export const sessionArtifactTypeSchema = z.enum([
  'html',
  'react',
  'markdown',
  'mermaid',
  'deck',
  'sheet',
]);

/** `private` is read by the owner alone; `public` by anyone holding its link. */
export const sessionArtifactVisibilitySchema = z.enum(['private', 'public']);

/** Who wrote a version: the agent with its tools, or the owner editing it in the panel. */
export const sessionArtifactAuthorSchema = z.enum(['agent', 'owner']);

const artifactIdSchema = z.uuid().describe('The id create_artifact returned.');

const slideHtmlSchema = z
  .string()
  .min(1)
  .max(SESSION_ARTIFACT_MAX)
  .describe(
    `One slide: a whole HTML page of its own, styles included, drawn on a fixed ${SLIDE_WIDTH}x${SLIDE_HEIGHT} canvas that is scaled to fit.`,
  );

const slidesSchema = z.array(slideHtmlSchema).min(1).max(DECK_SLIDES_MAX);

const slideNumberSchema = z.number().int().min(1).max(DECK_SLIDES_MAX);

/** How a deck's version is kept: its slides in order, as that version's `content`, in JSON. */
export const deckContentSchema = z.strictObject({ slides: slidesSchema });

/** What the agent gives to make one. */
export const sessionArtifactCreateSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).describe('A short name the owner reads in a list.'),
  type: sessionArtifactTypeSchema,
  content: z
    .string()
    .min(1)
    .max(SESSION_ARTIFACT_MAX)
    .optional()
    .describe('The whole source. For every type but deck.'),
  slides: slidesSchema.optional().describe('For a deck, in place of content: its slides in order.'),
});

/** A new version of one: the whole content again, never a patch. */
export const sessionArtifactRevisionSchema = z.strictObject({
  artifactId: artifactIdSchema,
  content: z
    .string()
    .min(1)
    .max(SESSION_ARTIFACT_MAX)
    .optional()
    .describe('The whole source, replaced. For every type but deck.'),
  slides: slidesSchema
    .optional()
    .describe('For a deck, in place of content: every slide again, in order.'),
  title: z.string().trim().min(1).max(120).optional().describe('Only to rename it.'),
});

/** What the agent gives to read one back, as it now stands or as a version of it was. */
export const sessionArtifactReadSchema = z.strictObject({
  artifactId: artifactIdSchema,
  version: z.number().int().min(1).optional().describe('Omit for the latest.'),
  slide: slideNumberSchema.optional().describe('A deck only: that slide alone, counting from 1.'),
});

/** One slide more in a deck. */
export const deckSlideAddSchema = z.strictObject({
  artifactId: artifactIdSchema,
  html: slideHtmlSchema,
  position: slideNumberSchema
    .optional()
    .describe(
      'The number it takes, counting from 1: the slide now there and those after it move one down. Omit to add it at the end.',
    ),
});

/** One slide of a deck, written again. */
export const deckSlideUpdateSchema = z.strictObject({
  artifactId: artifactIdSchema,
  slide: slideNumberSchema.describe('Which slide, counting from 1.'),
  html: slideHtmlSchema,
});

export const deckSlideDeleteSchema = z.strictObject({
  artifactId: artifactIdSchema,
  slide: slideNumberSchema.describe('Which slide, counting from 1.'),
});

export const deckSlideMoveSchema = z.strictObject({
  artifactId: artifactIdSchema,
  slide: slideNumberSchema.describe('Which slide, counting from 1.'),
  to: slideNumberSchema.describe('The number it has afterwards.'),
});

/**
 * What the owner saves after editing one by hand in the panel: the page, or one slide of a deck,
 * as it stands after the edit. It becomes a new version, made from the version that was edited.
 */
export const sessionArtifactEditSchema = z.strictObject({
  /** The version the owner was editing, which need not be the latest. */
  version: z.number().int().min(1),
  content: z.string().min(1).max(SESSION_ARTIFACT_MAX),
  /** A deck only, and required for one: the slide that was edited, counting from 1. */
  slide: slideNumberSchema.optional(),
  /**
   * Names one editing stretch, made by the panel when the owner starts editing. The first save of
   * a key adds a version; later saves with it replace that version's content while it is still
   * the latest and the owner's. If the agent wrote a newer one meanwhile, the save is a new
   * version on top and the answer's `version` says so.
   */
  editKey: z.string().min(8).max(64).optional(),
});

export const sessionArtifactSchema = z.strictObject({
  id: z.uuid(),
  sessionId: z.uuid(),
  title: z.string(),
  type: sessionArtifactTypeSchema,
  visibility: sessionArtifactVisibilitySchema,
  /** Its latest version. Versions count from 1, with none skipped. */
  version: z.number().int().min(1),
  /**
   * Where anyone reads its latest version while it is public, from the gateway's own address;
   * null while it is private. The link changes each time it is made public again.
   */
  publicPath: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** In place of a project's id: the conversations that are in no project. */
export const NO_PROJECT = 'none';

/**
 * What the agent's page of every Artifact asks for: those of all its conversations, the one
 * changed last first, a page at a time. `before` is the id of the last one already read.
 */
export const profileArtifactsQuerySchema = z.strictObject({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Words of its title, in any case. */
  q: z.string().trim().min(1).max(120).optional(),
  type: sessionArtifactTypeSchema.optional(),
  /** Only those the owner moved to this folder of theirs. */
  folder: z.uuid().optional(),
  /**
   * Only those in no folder of the owner's whose conversation is in this project, or with
   * `none` in no project: where each one is until it is moved.
   */
  project: z.union([z.uuid(), z.literal(NO_PROJECT)]).optional(),
  /** Only the pinned ones, or only the rest; absent for both. */
  pinned: z.enum(['true', 'false']).optional(),
});

/**
 * An Artifact as that page lists it: with the stored title and the project of the conversation
 * it belongs to, and where the owner keeps it on the page.
 */
export const profileArtifactSchema = sessionArtifactSchema.extend({
  sessionTitle: z.string().nullable(),
  /** The project of its conversation, which names the folder it is in until it is moved. */
  projectId: z.uuid().nullable(),
  pinned: z.boolean(),
  /** The owner's folder it was moved to; null while it is where it started. */
  folderId: z.uuid().nullable(),
});

export const profileArtifactPageSchema = z.strictObject({
  items: z.array(profileArtifactSchema),
  nextCursor: z.string().nullable(),
});

export const sessionArtifactVersionParamsSchema = z.strictObject({
  profileId: z.uuid(),
  sessionId: z.uuid(),
  artifactId: z.uuid(),
  version: z.coerce.number().int().min(1),
});

export const sessionArtifactVersionSchema = z.strictObject({
  artifactId: z.uuid(),
  version: z.number().int().min(1),
  author: sessionArtifactAuthorSchema,
  /** The source as it was written. A deck's is its slides as they are kept, in JSON. */
  content: z.string(),
  /** A React component as plain script, which is what its frame runs; absent for the rest. */
  compiled: z.string().optional(),
  /** A deck's slides in order, each a page of its own; absent for the rest. */
  slides: z.array(z.string()).optional(),
  createdAt: z.iso.datetime(),
});

/**
 * What the owner changes of one without making a version: who reads it, its name, whether it is
 * pinned on their page of them, and the folder of theirs it is kept in (`null` puts it back
 * where it started, under its conversation's project). At least one of them.
 */
export const sessionArtifactUpdateSchema = z
  .strictObject({
    visibility: sessionArtifactVisibilitySchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
    folderId: z.uuid().nullable().optional(),
  })
  .refine((change) => Object.values(change).some((value) => value !== undefined), {
    message: 'Say what to change.',
  });

/** A folder the owner made to keep Artifacts in, with how many it holds. */
export const artifactFolderSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  artifacts: z.number().int().min(0),
  createdAt: z.iso.datetime(),
});

export const artifactFolderInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
});

/**
 * Where an agent's Artifacts are kept: the owner's folders, by name, and the ones every Artifact
 * starts in, which are the projects of the conversations they were made in. Only a project that
 * still holds one is answered; `projectId` null is the conversations in no project.
 */
export const artifactFoldersSchema = z.strictObject({
  folders: z.array(artifactFolderSchema),
  projects: z.array(
    z.strictObject({
      projectId: z.uuid().nullable(),
      name: z.string().nullable(),
      artifacts: z.number().int().min(1),
    }),
  ),
});

/**
 * An Artifact taken away as a file. A deck is drawn by the gateway's own browser: `pdf` is every
 * slide, a page each, `png` one slide as a picture, and `pptx` every slide as a picture that
 * fills its page, with the slide's text in its notes. A Document (`markdown`) is `docx`, made
 * with no browser, or `pdf`, drawn on A4. A spreadsheet is `xlsx`, its formulas kept and their
 * values cached, or `csv`, the values alone. A format another type has is refused.
 */
export const deckExportQuerySchema = z.strictObject({
  format: z.enum(['pdf', 'png', 'pptx', 'docx', 'xlsx', 'csv']),
  /** `png` only, and required for it: the slide, counting from 1. */
  slide: z.coerce.number().int().min(1).max(DECK_SLIDES_MAX).optional(),
  /**
   * `basic` draws every slide again in fonts any computer has, whatever the slide asked for;
   * absent or `current`, in the fonts it is shown in.
   */
  fonts: z.enum(['current', 'basic']).optional(),
});

/** The file, in base64, as media is answered. */
export const deckExportSchema = z.strictObject({ mimeType: z.string(), data: z.string() });

/** The frame an Artifact of each type is drawn in, with nothing of any Artifact in it. */
export const artifactFrameParamsSchema = z.strictObject({ type: sessionArtifactTypeSchema });

/**
 * `edit=1` asks for the frame the owner edits by hand in, which a type outside
 * `EDITABLE_ARTIFACT_TYPES` does not have. It is a page of its own, so the frame that draws an
 * Artifact holds nothing that answers the panel.
 */
export const artifactFrameQuerySchema = z.strictObject({
  edit: z.literal('1').optional(),
  /**
   * `present=1` asks for a deck's player, the one its public link runs, already presenting. It is
   * handed the whole deck and never edits; only a deck has it.
   */
  present: z.literal('1').optional(),
  /**
   * The panel's theme, so the frame sets the same `color-scheme` as the element that holds it:
   * with a different one the browser paints an opaque canvas behind it, which is a flash of white
   * in a dark panel. Without it (a public link) the frame follows the reader's system.
   */
  theme: z.enum(['dark', 'light']).optional(),
});

/** The whole proof of a public Artifact's reader: 32 random bytes, in base64url. */
export const publicArtifactParamsSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/**
 * How the panel hands a frame what to draw: one message to the frame's window, with the source
 * (a React component's `compiled`, or one slide of a deck) under this key.
 */
export const ARTIFACT_FRAME_MESSAGE = 'jianArtifact';

/**
 * Editing by hand, between the panel and the frame of a type in `EDITABLE_ARTIFACT_TYPES`.
 * Everything said about it goes under this key:
 *
 * - Beside the source, `{ scale }` from the panel opens the frame for editing instead of running
 *   what it was handed; `{ scale }` again says how far the panel scales the frame since.
 * - `{ collect: <nonce> }` from the panel asks for the edited source. The frame answers that
 *   and nothing else, with `{ collect: <the same nonce>, html }`, or `{ collect, unchanged: true }`
 *   when nothing was edited. `html` is the source in the type's own form whatever the type: a
 *   page's markup, a document's Markdown, a spreadsheet's CSV.
 *
 * The frame says nothing it was not asked, and the panel reads nothing else from it.
 */
export const ARTIFACT_EDIT_MESSAGE = 'jianArtifactEdit';

/**
 * The one thing the deck's player says to the panel that holds it: `{ [this]: 'end' }`, when the
 * reader pressed Escape or its end button. The shell relays that and nothing else the frame says.
 */
export const ARTIFACT_PRESENT_MESSAGE = 'jianArtifactPresent';

/**
 * The panel's theme changed: `{ [this]: 'dark' | 'light' }` to the frame, which passes it inward.
 * The first theme is the frame's `theme` query; this only follows later changes.
 */
export const ARTIFACT_THEME_MESSAGE = 'jianArtifactTheme';

export type SessionArtifactType = z.infer<typeof sessionArtifactTypeSchema>;
export type SessionArtifactVisibility = z.infer<typeof sessionArtifactVisibilitySchema>;
export type SessionArtifactAuthor = z.infer<typeof sessionArtifactAuthorSchema>;
export type SessionArtifact = z.infer<typeof sessionArtifactSchema>;
export type ProfileArtifact = z.infer<typeof profileArtifactSchema>;
export type ArtifactFolder = z.infer<typeof artifactFolderSchema>;
export type ArtifactFolders = z.infer<typeof artifactFoldersSchema>;
export type SessionArtifactVersion = z.infer<typeof sessionArtifactVersionSchema>;
export type DeckExportQuery = z.infer<typeof deckExportQuerySchema>;
export type DeckExport = z.infer<typeof deckExportSchema>;

/**
 * The types the owner edits by hand in the panel: a page, a deck one slide at a time, a
 * document and a spreadsheet. What the agent wrote as code (a component, a
 * diagram) is changed by asking the agent.
 */
export const EDITABLE_ARTIFACT_TYPES: readonly SessionArtifactType[] = [
  'html',
  'deck',
  'markdown',
  'sheet',
];

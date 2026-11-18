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
 * What the frame draws it as: a whole page, one React component, a Markdown document, an SVG
 * picture, a Mermaid diagram, or a deck of slides, each a page of its own.
 */
export const sessionArtifactTypeSchema = z.enum([
  'html',
  'react',
  'markdown',
  'svg',
  'mermaid',
  'deck',
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

export const sessionArtifactUpdateSchema = z.strictObject({
  visibility: sessionArtifactVisibilitySchema,
});

/**
 * A deck taken away as a file, its slides drawn by the gateway's own browser: `pdf` is every
 * slide, a page each, `png` one slide as a picture, and `pptx` every slide as a picture that
 * fills its page, with the slide's text in its notes.
 */
export const deckExportQuerySchema = z.strictObject({
  format: z.enum(['pdf', 'png', 'pptx']),
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
export const artifactFrameQuerySchema = z.strictObject({ edit: z.literal('1').optional() });

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
 * - `{ collect: <nonce> }` from the panel asks for the edited markup. The frame answers that
 *   and nothing else, with `{ collect: <the same nonce>, html }`, or `{ collect, unchanged: true }`
 *   when nothing was edited.
 *
 * The frame says nothing it was not asked, and the panel reads nothing else from it.
 */
export const ARTIFACT_EDIT_MESSAGE = 'jianArtifactEdit';

export type SessionArtifactType = z.infer<typeof sessionArtifactTypeSchema>;
export type SessionArtifactVisibility = z.infer<typeof sessionArtifactVisibilitySchema>;
export type SessionArtifactAuthor = z.infer<typeof sessionArtifactAuthorSchema>;
export type SessionArtifact = z.infer<typeof sessionArtifactSchema>;
export type SessionArtifactVersion = z.infer<typeof sessionArtifactVersionSchema>;
export type DeckExportQuery = z.infer<typeof deckExportQuerySchema>;
export type DeckExport = z.infer<typeof deckExportSchema>;

/** The types the owner edits by hand in the panel: a page, and a deck one slide at a time. */
export const EDITABLE_ARTIFACT_TYPES: readonly SessionArtifactType[] = ['html', 'deck'];

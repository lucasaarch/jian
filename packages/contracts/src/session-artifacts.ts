import { z } from 'zod';

/**
 * An Artifact: something the agent made for the owner to see drawn beside the conversation, kept
 * with every version it had. Not a stored tool result, which `artifactSchema` is.
 */

/** The most one version holds, in characters. */
export const SESSION_ARTIFACT_MAX = 400_000;

/**
 * What the frame draws it as: a whole page, one React component, a Markdown document, an SVG
 * picture or a Mermaid diagram.
 */
export const sessionArtifactTypeSchema = z.enum(['html', 'react', 'markdown', 'svg', 'mermaid']);

/** `private` is read by the owner alone; `public` by anyone holding its link. */
export const sessionArtifactVisibilitySchema = z.enum(['private', 'public']);

/** What the agent gives to make one. */
export const sessionArtifactCreateSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).describe('A short name the owner reads in a list.'),
  type: sessionArtifactTypeSchema,
  content: z.string().min(1).max(SESSION_ARTIFACT_MAX).describe('The whole source.'),
});

/** A new version of one: the whole content again, never a patch. */
export const sessionArtifactRevisionSchema = z.strictObject({
  artifactId: z.uuid().describe('The id create_artifact returned.'),
  content: z.string().min(1).max(SESSION_ARTIFACT_MAX).describe('The whole source, replaced.'),
  title: z.string().trim().min(1).max(120).optional().describe('Only to rename it.'),
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
  /** The source as the agent wrote it. */
  content: z.string(),
  /** A React component as plain script, which is what its frame runs; absent for the rest. */
  compiled: z.string().optional(),
  createdAt: z.iso.datetime(),
});

export const sessionArtifactUpdateSchema = z.strictObject({
  visibility: sessionArtifactVisibilitySchema,
});

/** The frame an Artifact of each type is drawn in, with nothing of any Artifact in it. */
export const artifactFrameParamsSchema = z.strictObject({ type: sessionArtifactTypeSchema });

/** The whole proof of a public Artifact's reader: 32 random bytes, in base64url. */
export const publicArtifactParamsSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/**
 * How the panel hands a frame what to draw: one message to the frame's window, with the source
 * (a React component's `compiled`) under this key. The frame answers nothing and asks nothing.
 */
export const ARTIFACT_FRAME_MESSAGE = 'jianArtifact';

export type SessionArtifactType = z.infer<typeof sessionArtifactTypeSchema>;
export type SessionArtifactVisibility = z.infer<typeof sessionArtifactVisibilitySchema>;
export type SessionArtifact = z.infer<typeof sessionArtifactSchema>;
export type SessionArtifactVersion = z.infer<typeof sessionArtifactVersionSchema>;

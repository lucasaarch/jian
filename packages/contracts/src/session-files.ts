import { z } from 'zod';
import { sessionChangeSchema } from './records.js';

/** Files listed per root; a checkout past it is cut, and says so. */
export const SESSION_FILES_MAX = 20_000;
/** The most of one file the panel is sent, in bytes; past it the file is not shown. */
export const SESSION_FILE_MAX_BYTES = 1_000_000;

const rootIdSchema = z.string().min(1).max(200);
const pathSchema = z.string().min(1).max(4096);

/**
 * One folder a conversation's files come from: a project's checkout, or the conversation's own
 * worktree on the gateway. The panel only reads them; nothing here writes a file.
 */
export const sessionFileRootSchema = z.strictObject({
  /** What a file of this root is read by: the project's id, or `worktree:<name>`. */
  id: rootIdSchema,
  /** The project's or worktree's name, as the tree heads it. */
  name: z.string().min(1).max(200),
  /** Paths relative to the root, `/`-separated: tracked files and untracked ones git does not ignore. */
  files: z.array(pathSchema).max(SESSION_FILES_MAX),
  /** Uncommitted changes against HEAD (a worktree: its base), as Changes lists them. */
  changes: z
    .array(sessionChangeSchema.pick({ path: true, previousPath: true, status: true }))
    .max(2000),
  /** The list reached SESSION_FILES_MAX: do not present it as the whole checkout. */
  truncated: z.boolean(),
  /** Why this root could not be read, for one root of several; its lists are then empty. */
  unavailable: z.string().max(500).optional(),
});

export const sessionFilesSchema = z.strictObject({
  roots: z.array(sessionFileRootSchema).max(50),
});

export const sessionFileQuerySchema = z.strictObject({
  root: rootIdSchema,
  path: pathSchema,
});

/** One file as it is on disk now, read only. */
export const sessionFileSchema = z.strictObject({
  root: rootIdSchema,
  path: pathSchema,
  /** Its size on disk, in bytes. */
  size: z.number().int().min(0),
  /** Its text, UTF-8; absent when `unavailable` says why. */
  text: z.string().max(SESSION_FILE_MAX_BYTES).optional(),
  /** Why it is not shown: binary, larger than SESSION_FILE_MAX_BYTES, a link out of the checkout. */
  unavailable: z.string().max(500).optional(),
});

export type SessionFileRoot = z.infer<typeof sessionFileRootSchema>;
export type SessionFiles = z.infer<typeof sessionFilesSchema>;
export type SessionFile = z.infer<typeof sessionFileSchema>;

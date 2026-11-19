import { z } from 'zod';

/**
 * A link to one file of the agents' workspace, for what does not travel as an attachment: a
 * video over MAX_MEDIA_BYTES, or a service that takes a file by its address. Anyone holding the
 * link reads the file until it expires or is revoked, so lifetimes stay short by default.
 */

/** Minutes a link lasts when the agent names none: what services that fetch a file expect. */
export const FILE_LINK_DEFAULT_MINUTES = 60;
/** A week, in minutes: long enough to download later, short enough that a link is not forever. */
export const FILE_LINK_MAX_MINUTES = 7 * 24 * 60;
/** 2 GiB: a long finished video, well past what any conversation carries. */
export const FILE_LINK_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The path a link is read at. The token is the whole proof; the name only lets a service that
 * reads a file's type from its address see an extension, and is not checked. Both are loose here
 * on purpose: a malformed token must answer the same 404 as an unknown one, not a 400 saying why.
 */
export const fileLinkParamsSchema = z.strictObject({
  token: z.string().min(1).max(128),
  name: z.string().min(1).max(255),
});

import { z } from 'zod';

/** Terminals one gateway keeps open at once, across its profiles. */
export const TERMINALS_MAX = 12;
/** What a terminal keeps of its output to replay to a stream that opens later, in characters. */
export const TERMINAL_SCROLLBACK = 256_000;

export const terminalSizeSchema = z.strictObject({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500),
});

export const terminalInputSchema = z.strictObject({
  /**
   * The conversation it opens beside: it starts in that conversation's checkout or worktree.
   * Absent, or with none, it starts where the agent's commands do.
   */
  sessionId: z.uuid().optional(),
  ...terminalSizeSchema.shape,
});

/** A shell on the machine the gateway runs on, as the owner's own terminal. */
export const terminalSchema = z.strictObject({
  id: z.uuid(),
  sessionId: z.uuid().optional(),
  /** The folder it started in. */
  cwd: z.string().max(4096),
  /** The shell it runs, such as `/bin/bash`. */
  shell: z.string().max(4096),
  startedAt: z.iso.datetime(),
  /** Set once the shell has ended; the terminal is kept until it is closed. */
  exitCode: z.number().int().optional(),
});

export const terminalParamsSchema = z.strictObject({
  profileId: z.uuid(),
  terminalId: z.uuid(),
});

/** Keystrokes and pasted text, as the terminal on screen sends them. */
export const terminalWriteSchema = z.strictObject({
  data: z.string().min(1).max(65_536),
});

/**
 * What the output stream sends, as server-sent events: `output` with `{ data }`, first the
 * scrollback kept so far, then each new chunk; and `exit` with `{ exitCode }` once the shell ends.
 */
export const terminalOutputFrameSchema = z.strictObject({ data: z.string() });
export const terminalExitFrameSchema = z.strictObject({ exitCode: z.number().int() });

export type Terminal = z.infer<typeof terminalSchema>;
export type TerminalInput = z.infer<typeof terminalInputSchema>;

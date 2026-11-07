import { z } from 'zod';

/**
 * Which tool server a call went to, and the tool by the server's own name. The name the agent
 * calls it by is cut and hashed to stay unique, so it cannot be read back into these.
 */
export const mcpToolRefSchema = z.strictObject({
  server: z.string().max(100),
  tool: z.string().max(200),
});

/**
 * What the agent is doing right now, while it is doing it. Presentation only: the answer is
 * written to history when the run ends, so nothing here is ever the record of what was said.
 * It is a column rather than an event because a reader wants the latest state, not every one,
 * and it is told in the event stream, so a panel never has to re-read history to follow a run.
 */
export const runProgressSchema = z.strictObject({
  phase: z.enum(['thinking', 'tool', 'writing']),
  /** The tool now running. Chat channels never render it; the panel does. */
  tool: z.string().max(100).optional(),
  /** Set when that tool belongs to an MCP server. */
  mcp: mcpToolRefSchema.optional(),
  /** The current answer segment, reset whenever a tool interrupts it, so it converges. */
  text: z.string().max(8000).default(''),
  steps: z.number().int().nonnegative().default(0),
  updatedAt: z.iso.datetime(),
});

export type RunProgress = z.infer<typeof runProgressSchema>;

/**
 * The `run.progress` stream frame. It has no id, so it never moves the cursor a client resumes
 * from. `progress` is absent until the run has reported once, and on gateways older than this
 * field, so a reader must treat it as optional.
 */
export const runProgressEventSchema = z.object({
  runId: z.uuid(),
  sessionId: z.uuid(),
  at: z.string(),
  progress: runProgressSchema.optional(),
});

export type RunProgressEvent = z.infer<typeof runProgressEventSchema>;

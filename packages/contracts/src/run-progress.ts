import { z } from 'zod';
import {
  DECK_SLIDES_MAX,
  SESSION_ARTIFACT_MAX,
  sessionArtifactTypeSchema,
} from './session-artifacts.js';

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
  /**
   * Set while the run waits to try the model again after a call failed for a network or
   * availability reason; absent once a call gets through. Those calls are retried without end.
   */
  reconnecting: z
    .strictObject({
      /** Failed attempts in a row so far. */
      attempts: z.number().int().positive(),
      /** When the next attempt goes out. */
      nextAt: z.iso.datetime(),
      /** Why the last one failed, in a few words: a status or a network failure, never a body. */
      reason: z.string().max(200),
    })
    .optional(),
  /**
   * An Artifact the agent is writing right now, as far as its tool call has been written. Never a
   * version: it ends when the tool runs (the version takes over) or fails, and nothing of it is
   * kept. Whoever may read the run's progress may read it, no one else.
   */
  artifact: z
    .strictObject({
      toolCallId: z.string().max(200),
      /** Set when the call revises one, once the model has written its id in full. */
      artifactId: z.uuid().optional(),
      title: z.string().max(120).optional(),
      type: sessionArtifactTypeSchema.optional(),
      /**
       * The source so far; for a deck its slides one after another. Empty for a call that changes
       * one by replacements (`edit_artifact`), which says only which Artifact it changes.
       */
      content: z.string().max(SESSION_ARTIFACT_MAX).default(''),
      /**
       * A deck's slides written in full so far, the one still being written left out, so the
       * panel draws each as it is finished. Together within one Artifact's bound. Absent for
       * anything else, and from gateways older than this field.
       */
      slides: z.array(z.string().max(SESSION_ARTIFACT_MAX)).max(DECK_SLIDES_MAX).optional(),
    })
    .optional(),
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

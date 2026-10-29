import { z } from 'zod';

/**
 * What the agent is doing right now, while it is doing it. Presentation only: the answer is
 * written to history when the run ends, so nothing here is ever the record of what was said.
 * It is a column rather than an event because a reader wants the latest state, not every one.
 */
export const runProgressSchema = z.strictObject({
  phase: z.enum(['thinking', 'tool', 'writing']),
  /** The tool now running. Chat channels never render it; the panel does. */
  tool: z.string().max(100).optional(),
  /** The current answer segment, reset whenever a tool interrupts it, so it converges. */
  text: z.string().max(8000).default(''),
  steps: z.number().int().nonnegative().default(0),
  updatedAt: z.iso.datetime(),
});

export type RunProgress = z.infer<typeof runProgressSchema>;

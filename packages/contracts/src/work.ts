import { z } from 'zod';

export const subagentRoleSchema = z.enum(['execute', 'review']);

export const conversationSubagentInputSchema = z.strictObject({
  role: subagentRoleSchema,
  name: z.string().trim().min(1).max(80),
  identity: z.string().trim().min(1).max(4000),
  brief: z.string().trim().min(1).max(3000),
  mediaIds: z.array(z.uuid()).max(4).optional(),
  repositories: z.array(z.string().trim().min(1).max(4096)).max(4).optional(),
});

export const subagentSchema = conversationSubagentInputSchema
  .pick({ role: true, name: true, identity: true })
  .extend({
    parentRunId: z.uuid(),
    spawnKey: z.string().min(1).max(120),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    repositories: z.array(z.string()).max(4).optional(),
  });
export type Subagent = z.infer<typeof subagentSchema>;

export const conversationSubagentSchema = z.strictObject({
  runId: z.uuid(),
  sessionId: z.uuid(),
  parentRunId: z.uuid(),
  role: subagentRoleSchema,
  name: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']),
  input: z.string(),
  output: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

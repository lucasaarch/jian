import { z } from 'zod';

export const remoteMachineSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  platform: z.string(),
  online: z.boolean(),
  allowedProfileIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
});

export const remoteMachineCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  allowedProfileIds: z.array(z.uuid()).max(100).default([]),
});

export const remoteMachineCreatedSchema = remoteMachineSchema.extend({ token: z.string().min(32) });
export const remoteMachineAccessSchema = z.strictObject({
  allowedProfileIds: z.array(z.uuid()).max(100),
});

export const remoteCommandSchema = z.strictObject({
  command: z.string().min(1).max(8000),
  cwd: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

export const remoteTaskSchema = z.strictObject({
  id: z.uuid(),
  command: z.string(),
  cwd: z.string().nullable(),
  timeoutMs: z.number().int(),
});

export const remoteResultSchema = z.strictObject({
  taskId: z.uuid(),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(50000),
  stderr: z.string().max(50000),
  timedOut: z.boolean().default(false),
});

export const remoteWorkerPollSchema = z.strictObject({ task: remoteTaskSchema.nullable() });
export const remoteWorkerResultSchema = z.strictObject({ ok: z.literal(true) });
export const remoteMachineDeleteSchema = z.strictObject({ id: z.uuid() });
export type RemoteMachine = z.infer<typeof remoteMachineSchema>;
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;

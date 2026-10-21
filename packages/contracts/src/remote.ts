import { z } from 'zod';

export const remoteMachineSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  platform: z.string(),
  online: z.boolean(),
  allowedProfileIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
  /** Worker advertised capabilities (e.g. computer-macos-v1 / linux / windows). */
  capabilities: z.array(z.string()).default([]),
});

export const remoteMachineCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  allowedProfileIds: z.array(z.uuid()).max(100).default([]),
});

export const remoteMachineCreatedSchema = remoteMachineSchema.extend({ token: z.string().min(32) });
/** Same shape as create: machine fields plus the new worker token (shown once). */
export const remoteMachineRotatedSchema = remoteMachineCreatedSchema;
export const remoteMachineAccessSchema = z.strictObject({
  allowedProfileIds: z.array(z.uuid()).max(100),
});

export const remoteCommandSchema = z.strictObject({
  command: z.string().min(1).max(8000),
  cwd: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

const coordinateSchema = z.tuple([z.number().int(), z.number().int()]);

/** Anthropic-style computer actions for Remote Control (desktop computer use). */
export const remoteComputerActionSchema = z.enum([
  'screenshot',
  'left_click',
  'right_click',
  'double_click',
  'mouse_move',
  'type',
  'key',
  'scroll',
  'left_click_drag',
  'wait',
  'end_session',
]);

export const remoteComputerParamsSchema = z.strictObject({
  action: remoteComputerActionSchema,
  coordinate: coordinateSchema.optional(),
  startCoordinate: coordinateSchema.optional(),
  text: z.string().min(1).max(4000).optional(),
  key: z.string().min(1).max(100).optional(),
  scrollDirection: z.enum(['up', 'down', 'left', 'right']).optional(),
  scrollAmount: z.number().int().min(1).max(20).optional(),
  duration: z.number().min(0).max(5).optional(),
});

export const remoteComputerCommandSchema = z.strictObject({
  action: remoteComputerActionSchema,
  coordinate: coordinateSchema.optional(),
  startCoordinate: coordinateSchema.optional(),
  text: z.string().min(1).max(4000).optional(),
  key: z.string().min(1).max(100).optional(),
  scrollDirection: z.enum(['up', 'down', 'left', 'right']).optional(),
  scrollAmount: z.number().int().min(1).max(20).optional(),
  duration: z.number().min(0).max(5).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

export const remoteTaskKindSchema = z.enum(['shell', 'computer']);

export const remoteTaskSchema = z.strictObject({
  id: z.uuid(),
  kind: remoteTaskKindSchema.default('shell'),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  timeoutMs: z.number().int(),
  computer: remoteComputerParamsSchema.optional(),
});

export const remoteComputerResultSchema = z.strictObject({
  ok: z.boolean(),
  widthPx: z.number().int().positive().optional(),
  heightPx: z.number().int().positive().optional(),
  scale: z
    .strictObject({
      imageToPointX: z.number().positive(),
      imageToPointY: z.number().positive(),
    })
    .optional(),
  error: z.string().max(2000).optional(),
});

export const remoteResultSchema = z.strictObject({
  taskId: z.uuid(),
  exitCode: z.number().int().nullable(),
  // Room for a compressed screenshot or a small file as base64 through the worker channel.
  stdout: z.string().max(400_000),
  stderr: z.string().max(50_000),
  timedOut: z.boolean().default(false),
  computer: remoteComputerResultSchema.optional(),
});

export const remoteWorkerPollSchema = z.strictObject({ task: remoteTaskSchema.nullable() });
export const remoteWorkerResultSchema = z.strictObject({ ok: z.literal(true) });
export const remoteMachineDeleteSchema = z.strictObject({ id: z.uuid() });
export type RemoteMachine = z.infer<typeof remoteMachineSchema>;
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;
export type RemoteComputerParams = z.infer<typeof remoteComputerParamsSchema>;
export type RemoteComputerCommand = z.infer<typeof remoteComputerCommandSchema>;

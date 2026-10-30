import { z } from 'zod';

/** macOS session posture from the worker (lock ≠ offline). */
export const remoteUiStateSchema = z.enum(['unlocked', 'locked', 'display_asleep', 'unknown']);

/** The OS and architecture a worker runs on, as Node names them: `darwin-arm64`, `win32-x64`. */
export const remotePlatformSchema = z.string().regex(/^(darwin|linux|win32)-(arm64|x64)$/);

/** Longest system description kept, in characters; a longer report is cut to it. */
export const REMOTE_SYSTEM_MAX_LENGTH = 100;

/** The OS by name and version as a person reads it: `macOS 27.2`, `Windows 11 (26100)`. */
export const remoteSystemSchema = z.string().trim().min(1).max(REMOTE_SYSTEM_MAX_LENGTH);

export const remoteMachineSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** `darwin-arm64`, `win32-x64`, ...; `unknown` until the worker or its creator says. */
  platform: z.string(),
  /** The OS by name and version, as the worker last reported it; null until known. */
  system: z.string().nullable().default(null),
  online: z.boolean(),
  createdAt: z.iso.datetime(),
  /** Worker advertised capabilities (e.g. computer-macos-v1 / linux / windows). */
  capabilities: z.array(z.string()).default([]),
  /**
   * Screen lock / display sleep as reported by the worker. Online means the poller is alive;
   * locked means Computer Use needs an unlock (shell may still work).
   */
  uiState: remoteUiStateSchema.default('unknown'),
  /** The Jian Remote release the worker last reported; null until it has polled. */
  version: z.string().nullable().default(null),
  /**
   * Its major.minor differs from this gateway's release: agents cannot use it until it is
   * updated, and an update is the only task it is given.
   */
  outdated: z.boolean().default(false),
  /** It can update itself on request: its worker was installed with npm (`update-npm`). */
  updatable: z.boolean().default(false),
});

/**
 * Every agent may use every machine; a machine is only a name and a worker token. A creator
 * that runs on the machine itself, such as the desktop app, can say what it is at once, so the
 * record shows it before the worker's first poll; that poll then keeps it current.
 */
export const remoteMachineCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  platform: remotePlatformSchema.optional(),
  system: remoteSystemSchema.optional(),
});

export const remoteMachineCreatedSchema = remoteMachineSchema.extend({ token: z.string().min(32) });
/** Same shape as create: machine fields plus the new worker token (shown once). */
export const remoteMachineRotatedSchema = remoteMachineCreatedSchema;

export const remoteCommandSchema = z.strictObject({
  command: z.string().min(1).max(8000),
  cwd: z.string().min(1).max(4096).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
});

const coordinateSchema = z.tuple([z.number().int(), z.number().int()]);

/** Anthropic-style computer actions on a machine (desktop computer use). */
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

/** Bring the machine's worker to a release; what it installs with is the worker's own. */
export const remoteUpdateParamsSchema = z.strictObject({
  /** A release such as 1.2.3, or `latest`. */
  version: z.string().regex(/^(latest|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/),
});

export const remoteTaskKindSchema = z.enum(['shell', 'computer', 'update']);

export const remoteTaskSchema = z.strictObject({
  id: z.uuid(),
  kind: remoteTaskKindSchema.default('shell'),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  timeoutMs: z.number().int(),
  computer: remoteComputerParamsSchema.optional(),
  update: remoteUpdateParamsSchema.optional(),
  /**
   * A shell task's secret environment, such as a credential the command needs: added to that
   * command alone. A worker that advertises `shell-secret-env-v1` never logs it and masks its
   * values in what it sends back.
   */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)).optional(),
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
  /** The releases an update task went from and to; the worker restarts after posting it. */
  update: z.strictObject({ from: z.string(), to: z.string() }).optional(),
});

/** What updating a machine came to, for the owner in the panel and for an agent. */
export const remoteMachineUpdateSchema = z.strictObject({
  ok: z.boolean(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  message: z.string(),
});

export const remoteWorkerPollSchema = z.strictObject({ task: remoteTaskSchema.nullable() });
export const remoteWorkerResultSchema = z.strictObject({ ok: z.literal(true) });
export const remoteMachineDeleteSchema = z.strictObject({ id: z.uuid() });
export type RemoteMachine = z.infer<typeof remoteMachineSchema>;
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;
export type RemoteComputerParams = z.infer<typeof remoteComputerParamsSchema>;
export type RemoteComputerCommand = z.infer<typeof remoteComputerCommandSchema>;
/** A task as the gateway hands it to a worker. */
export type RemoteTask = z.infer<typeof remoteTaskSchema>;
/** What a worker posts back, before the gateway fills its defaults in. */
export type RemoteResult = z.input<typeof remoteResultSchema>;
export type RemoteComputerResult = z.input<typeof remoteComputerResultSchema>;
export type RemoteUpdateParams = z.infer<typeof remoteUpdateParamsSchema>;
export type RemoteMachineUpdate = z.infer<typeof remoteMachineUpdateSchema>;

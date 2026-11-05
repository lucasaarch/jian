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

export const remoteTaskKindSchema = z.enum(['shell', 'computer', 'update', 'browser', 'files']);

/**
 * Says a request comes from the desktop app, which signs it on its way out. Only that app has a
 * browser beside the conversation; the web panel and the channels never send this.
 */
export const JIAN_CLIENT_HEADER = 'x-jian-client';
export const JIAN_DESKTOP_CLIENT = 'desktop';

/** What a worker says when the browser beside the conversations is its to drive: the app's. */
export const REMOTE_BROWSER_CAPABILITY = 'browser-v1';

/**
 * An action in the browser beside one conversation, in the app that is this machine. The input
 * goes as it is: the app validates it again, as it does what its own gateway asks.
 */
export const remoteBrowserParamsSchema = z.strictObject({
  // `check` only asks whether the owner is watching; nothing happens in the browser.
  operation: z.enum(['act', 'inspect', 'check']),
  profileId: z.uuid(),
  sessionId: z.uuid(),
  input: z.unknown(),
});

/**
 * What the app answered. `notShowing` is a refusal before anything happened: the owner is not
 * looking at that conversation, so nothing may be done where they cannot watch it.
 */
export const remoteBrowserResultSchema = z.strictObject({
  notShowing: z.literal(true).optional(),
  error: z.string().max(2000).optional(),
  acted: z.unknown().optional(),
  capture: z
    .strictObject({ screenshot: z.string(), archive: z.string(), snapshot: z.unknown() })
    .optional(),
});

/** What a worker says when it runs `files` tasks: file operations with Node's `fs`, no shell. */
export const REMOTE_FILES_CAPABILITY = 'files-v1';

/**
 * Absolute on the worker's own system: POSIX `/…` or Windows `C:\…` / `C:/…`. A relative path
 * would resolve against whatever folder the worker happens to run in.
 */
const remoteFilesPathSchema = z
  .string()
  .max(4096)
  .regex(/^(\/|[A-Za-z]:[\\/])/)
  .refine((path) => !path.includes('\0'), 'A path cannot contain NUL.');

const remoteFilesShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** The largest file a read may ask for, as the local file tools allow. */
export const REMOTE_FILES_MAX_READ_BYTES = 20 * 1024 * 1024;
/** The largest git file kept, in bytes. */
export const REMOTE_FILES_MAX_GIT_BYTES = 500_000;
/** Longest text a write or a read answer carries; a result must stay under 480,000 bytes. */
export const REMOTE_FILES_MAX_TEXT = 400_000;

/** One file operation on a machine. */
export const remoteFilesOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('read'),
    path: remoteFilesPathSchema,
    maxBytes: z.number().int().min(1).max(REMOTE_FILES_MAX_READ_BYTES),
  }),
  z.strictObject({
    op: z.literal('write'),
    path: remoteFilesPathSchema,
    content: z.string().max(REMOTE_FILES_MAX_TEXT),
    /** The mtime the writer read; null means the file must not exist. A mismatch is `changed`. */
    expectedMtimeMs: z.number().nullable(),
  }),
  z.strictObject({
    op: z.literal('list'),
    path: remoteFilesPathSchema,
    limit: z.number().int().min(1).max(300),
  }),
  z.strictObject({
    op: z.literal('find'),
    path: remoteFilesPathSchema,
    pattern: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(1000),
  }),
  z.strictObject({
    op: z.literal('search'),
    path: remoteFilesPathSchema,
    pattern: z.string().min(1).max(2000),
    glob: z.string().max(200).optional(),
    ignoreCase: z.boolean(),
    contextLines: z.number().int().min(0).max(10),
    output: z.enum(['content', 'files', 'count']),
    limit: z.number().int().min(1).max(2000),
  }),
  z.strictObject({
    op: z.literal('read-bytes'),
    path: remoteFilesPathSchema,
    maxBytes: z.number().int().min(1).max(REMOTE_FILES_MAX_READ_BYTES),
  }),
  z.strictObject({
    op: z.literal('write-bytes'),
    path: remoteFilesPathSchema,
    // Base64 of at most 300,000 bytes, which keeps the task far under the channel's size.
    base64: z
      .string()
      .max(REMOTE_FILES_MAX_TEXT)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
  z.strictObject({
    op: z.literal('git-status'),
    root: remoteFilesPathSchema,
    /** Also diff the working tree against this commit. */
    against: remoteFilesShaSchema.optional(),
  }),
  z.strictObject({
    op: z.literal('git-file'),
    root: remoteFilesPathSchema,
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => !p.includes('\0'), 'No NUL.'),
    against: z.union([remoteFilesShaSchema, z.literal('HEAD')]),
    maxBytes: z.number().int().min(1).max(REMOTE_FILES_MAX_GIT_BYTES),
  }),
  z.strictObject({
    op: z.literal('merge-base'),
    root: remoteFilesPathSchema,
    base: z.string().min(1).max(256),
  }),
]);

export const remoteFilesProblemSchema = z.enum([
  'missing',
  'not-file',
  'not-directory',
  'binary',
  'too-large',
  'changed',
  'exists',
  'refused',
  'not-repository',
  'failed',
]);

const remoteFilesRawSchema = z.string().max(REMOTE_FILES_MAX_TEXT);

/** What the worker answered; `op` repeats the request's so the gateway can match the two. */
export const remoteFilesAnswerSchema = z.union([
  z.discriminatedUnion('op', [
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('read'),
      text: remoteFilesRawSchema,
      mtimeMs: z.number(),
      bytes: z.number().int().min(0),
    }),
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('write'),
      mtimeMs: z.number(),
      bytes: z.number().int().min(0),
      created: z.boolean(),
    }),
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('list'),
      entries: z
        .array(
          z.strictObject({
            name: z.string().max(1024),
            kind: z.enum(['file', 'directory', 'symlink', 'other']),
          }),
        )
        .max(300),
      truncated: z.boolean(),
    }),
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('find'),
      files: z.array(z.string().max(4096)).max(1000),
      truncated: z.boolean(),
    }),
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('search'),
      /** Output lines as the gateway's search prints them; the total stays within 60,000 characters. */
      matches: z.array(z.string().max(60_000)).max(2000),
      truncated: z.boolean(),
    }),
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('read-bytes'),
      base64: z.string().max(REMOTE_FILES_MAX_TEXT),
      bytes: z.number().int().min(0),
    }),
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('write-bytes'),
      bytes: z.number().int().min(0),
    }),
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('git-status'),
      top: z.string().max(4096),
      filters: z.array(z.string().max(1024)).max(200),
      /** Raw `git status --porcelain -z` and `git diff -z` outputs, for the gateway's parsers. */
      status: remoteFilesRawSchema,
      diff: remoteFilesRawSchema.optional(),
    }),
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('git-file'),
      before: z.string().max(REMOTE_FILES_MAX_GIT_BYTES).nullable(),
      after: z.string().max(REMOTE_FILES_MAX_GIT_BYTES).nullable(),
      binary: z.boolean().optional(),
    }),
    z.strictObject({
      ok: z.literal(true),
      op: z.literal('merge-base'),
      sha: remoteFilesShaSchema,
    }),
  ]),
  z.strictObject({
    ok: z.literal(false),
    op: z.enum([
      'read',
      'write',
      'list',
      'find',
      'search',
      'read-bytes',
      'write-bytes',
      'git-status',
      'git-file',
      'merge-base',
    ]),
    problem: remoteFilesProblemSchema,
    message: z.string().max(2000),
  }),
]);

export const remoteTaskSchema = z.strictObject({
  id: z.uuid(),
  kind: remoteTaskKindSchema.default('shell'),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  timeoutMs: z.number().int(),
  computer: remoteComputerParamsSchema.optional(),
  update: remoteUpdateParamsSchema.optional(),
  browser: remoteBrowserParamsSchema.optional(),
  files: remoteFilesOpSchema.optional(),
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
  browser: remoteBrowserResultSchema.optional(),
  files: remoteFilesAnswerSchema.optional(),
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
export type RemoteBrowserParams = z.infer<typeof remoteBrowserParamsSchema>;
export type RemoteBrowserResult = z.infer<typeof remoteBrowserResultSchema>;
export type RemoteFilesOp = z.infer<typeof remoteFilesOpSchema>;
export type RemoteFilesAnswer = z.infer<typeof remoteFilesAnswerSchema>;
export type RemoteComputerCommand = z.infer<typeof remoteComputerCommandSchema>;
/** A task as the gateway hands it to a worker. */
export type RemoteTask = z.infer<typeof remoteTaskSchema>;
/** What a worker posts back, before the gateway fills its defaults in. */
export type RemoteResult = z.input<typeof remoteResultSchema>;
export type RemoteComputerResult = z.input<typeof remoteComputerResultSchema>;
export type RemoteUpdateParams = z.infer<typeof remoteUpdateParamsSchema>;
export type RemoteMachineUpdate = z.infer<typeof remoteMachineUpdateSchema>;

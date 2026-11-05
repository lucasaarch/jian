import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  REMOTE_BROWSER_CAPABILITY,
  REMOTE_FILES_CAPABILITY,
  REMOTE_SYSTEM_MAX_LENGTH,
  type RemoteBrowserParams,
  type RemoteBrowserResult,
  type RemoteComputerParams,
  type RemoteFilesAnswer,
  type RemoteFilesOp,
  type RemoteMachineUpdate,
  type RemoteUpdateParams,
  remoteBrowserParamsSchema,
  remoteCommandSchema,
  remoteComputerCommandSchema,
  remoteComputerParamsSchema,
  remoteFilesAnswerSchema,
  remoteFilesOpSchema,
  remoteMachineCreateSchema,
  remotePlatformSchema,
  remoteResultSchema,
  remoteUpdateParamsSchema,
} from '@jian/contracts';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import { gatewayRelease, workerOutdated } from '../core/release.js';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { remoteMachines, remoteTasks } from '../storage/schema.js';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const present = (lastSeen: Date | null, now: number) =>
  !!lastSeen && now - lastSeen.getTime() < 60_000;

/** Worker capability strings that unlock remote_computer (one per OS backend). */
const COMPUTER_CAPABILITIES = new Set([
  'computer-macos-v1',
  'computer-linux-v1',
  'computer-windows-v1',
]);

function machineSupportsComputer(machine: { capabilities: string[] | null }): boolean {
  return (machine.capabilities ?? []).some((cap) => COMPUTER_CAPABILITIES.has(cap));
}

/**
 * Worker capabilities that mean "I can update myself when asked": a CLI installed with npm
 * reinstalls its package. A native app would advertise its own and call its app's updater.
 */
const UPDATE_CAPABILITIES = new Set(['update-npm']);

function machineCanUpdate(machine: { capabilities: string[] | null }): boolean {
  return (machine.capabilities ?? []).some((cap) => UPDATE_CAPABILITIES.has(cap));
}

/** A worker that runs a shell task with a secret environment it neither logs nor echoes. */
const SECRET_ENV_CAPABILITY = 'shell-secret-env-v1';
/** A page can take a while to load and settle; the browser's own limit is 45 seconds. */
const BROWSER_TIMEOUT_MS = 60_000;

/**
 * What a files answer holds of a file's contents, search output included; the stored row keeps
 * the rest: op, sizes, and the paths and names in `entries` and `files`.
 */
const FILE_CONTENT_FIELDS = new Set([
  'text',
  'base64',
  'matches',
  'before',
  'after',
  'status',
  'diff',
]);

/** What a write's payload holds of the caller's file: the rest says what the task was. */
const withoutWrittenContent = (payload: Record<string, unknown> | null) => {
  if (!payload) return payload;
  const { content: _content, base64: _base64, ...kept } = payload;
  return kept;
};

/**
 * A files operation as the contract takes it. What it refuses reaches an agent as a tool's
 * failure, so it is one sentence naming the field instead of the schema's JSON.
 */
function filesOp(input: RemoteFilesOp): RemoteFilesOp {
  const parsed = remoteFilesOpSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.') || 'operation';
  const reason = (issue?.message ?? 'Invalid.').replace(/\.?$/, '.');
  throw new GatewayError(400, `The ${field} of this file operation is refused: ${reason}`);
}

/** Where a task's secret environment waits, encrypted, until its worker claims it. */
const secretEnvKey = (taskId: string) => `remote-task-env:${taskId}`;

/** npm and the handover to the new worker can take minutes on a slow link, in ms. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;

type Machine = typeof remoteMachines.$inferSelect;

/** A files answer as `complete` stored it: its JSON text (see there). */
const storedFiles = (files: unknown): unknown => {
  if (typeof files !== 'string') return files;
  try {
    return JSON.parse(files);
  } catch {
    return undefined;
  }
};

type TaskResult = {
  taskId?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  computer?: unknown;
  update?: { from: string; to: string };
  browser?: RemoteBrowserResult;
  files?: unknown;
};

const UI_STATES = new Set(['unlocked', 'locked', 'display_asleep', 'unknown'] as const);
type RemoteUiState = 'unlocked' | 'locked' | 'display_asleep' | 'unknown';

function parseCapabilities(header: string | undefined): string[] {
  if (!header?.trim()) return [];
  return [
    ...new Set(
      header
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function parseUiState(header: string | undefined): RemoteUiState {
  const value = header?.trim().toLowerCase();
  if (value && UI_STATES.has(value as RemoteUiState)) return value as RemoteUiState;
  return 'unknown';
}

/** A version header is the worker's word, kept short and printable before it is stored. */
function parseVersion(header: string | undefined): string | null {
  const value = header?.trim().replace(/^v/, '');
  return value && /^[0-9A-Za-z.+-]{1,40}$/.test(value) ? value : null;
}

/**
 * A system header is the worker's word, shown to the owner and to agents: control characters
 * and runs of spaces go, and it is cut to the stored length. Blank means it did not say.
 */
function parseSystem(header: string | undefined): string | null {
  const value = header
    ?.replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REMOTE_SYSTEM_MAX_LENGTH)
    .trim();
  return value || null;
}

function publicMachine(
  machine: Machine,
  now: number,
  release: string | undefined,
): {
  id: string;
  name: string;
  platform: string;
  system: string | null;
  online: boolean;
  createdAt: string;
  capabilities: string[];
  uiState: RemoteUiState;
  version: string | null;
  outdated: boolean;
  updatable: boolean;
} {
  return {
    id: machine.id,
    name: machine.name,
    platform: machine.platform,
    system: machine.system,
    online: present(machine.lastSeenAt, now),
    createdAt: machine.createdAt.toISOString(),
    capabilities: machine.capabilities ?? [],
    uiState: parseUiState(machine.uiState),
    version: machine.version,
    outdated: workerOutdated(machine.version, release),
    updatable: machineCanUpdate(machine),
  };
}

export class Remote {
  constructor(
    private store: Store,
    private clock: () => number = Date.now,
    private release: () => string | undefined = () => gatewayRelease(),
    /** Holds a task's secret environment; without it, no task can carry one. */
    private vault?: Pick<GatewayVault, 'put' | 'read' | 'discard'>,
  ) {}

  async list() {
    const rows = await this.store.db
      .select()
      .from(remoteMachines)
      .orderBy(asc(remoteMachines.createdAt));
    const now = this.clock();
    const release = this.release();
    return rows.map((machine) => publicMachine(machine, now, release));
  }

  async create(input: unknown) {
    const data = remoteMachineCreateSchema.parse(input);
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date(this.clock());
    const platform = data.platform ?? 'unknown';
    const system = data.system ?? null;
    await this.store.db.insert(remoteMachines).values({
      id,
      name: data.name,
      platform,
      system,
      tokenHash: tokenHash(token),
      capabilities: [],
      createdAt,
    });
    return {
      id,
      name: data.name,
      platform,
      system,
      online: false,
      createdAt: createdAt.toISOString(),
      capabilities: [] as string[],
      uiState: 'unknown' as const,
      version: null,
      outdated: false,
      updatable: false,
      token,
    };
  }

  /** Issue a new worker token and invalidate the previous hash. Token is returned once. */
  async rotate(machineId: string) {
    const token = randomBytes(32).toString('base64url');
    const [machine] = await this.store.db
      .update(remoteMachines)
      .set({ tokenHash: tokenHash(token) })
      .where(eq(remoteMachines.id, machineId))
      .returning();
    if (!machine) throw new GatewayError(404, 'Remote machine not found');
    return { ...publicMachine(machine, this.clock(), this.release()), token };
  }

  async remove(machineId: string) {
    const [machine] = await this.store.db
      .delete(remoteMachines)
      .where(eq(remoteMachines.id, machineId))
      .returning({ id: remoteMachines.id });
    if (!machine) throw new GatewayError(404, 'Remote machine not found');
    return machine;
  }

  /**
   * Runs a shell command on a machine. `secretEnv` is added to that command's environment
   * alone: a credential the command needs, which must not be in the command itself, since
   * the task row and the worker's log both keep that. The values live encrypted in the gateway
   * vault until the worker claims the task, and are gone once the task ends; the row names
   * the variables, never their values.
   */
  async execute(
    profileId: string,
    machineId: string,
    input: unknown,
    signal?: AbortSignal,
    secretEnv?: Record<string, string>,
  ) {
    const data = remoteCommandSchema.parse(input);
    const machine = await this.machine(machineId);
    this.requireCurrent(machine);
    const task = {
      kind: 'shell' as const,
      command: data.command,
      cwd: data.cwd ?? null,
      payload: secretEnv ? { env: Object.keys(secretEnv) } : null,
      timeoutMs: data.timeoutMs,
    };
    if (!secretEnv) return this.waitForTask(profileId, machineId, task, signal);

    const vault = this.requireSecretEnv(machine);
    const taskId = randomUUID();
    await vault.put(secretEnvKey(taskId), JSON.stringify(secretEnv));
    try {
      return await this.waitForTask(profileId, machineId, task, signal, taskId);
    } finally {
      await vault.discard(secretEnvKey(taskId)).catch(() => {});
    }
  }

  /** Only a present worker that keeps a secret environment to itself is handed one. */
  private requireSecretEnv(machine: Machine) {
    if (!this.vault) throw new GatewayError(500, 'This gateway cannot hand a machine credentials.');
    if (!present(machine.lastSeenAt, this.clock())) {
      throw new GatewayError(503, `${machine.name} is offline`);
    }
    if (!(machine.capabilities ?? []).includes(SECRET_ENV_CAPABILITY)) {
      throw new GatewayError(
        409,
        `${machine.name} runs a Jian Remote that cannot take credentials for a command. Update it first: update_remote_machine, or Update under Machines in the panel's settings.`,
      );
    }
    return this.vault;
  }

  /**
   * The machines that can drive the browser beside a conversation, most recently heard from
   * first: apps that are online, or only the one a conversation is aimed at.
   */
  async browserMachines(targetMachineId?: string) {
    const rows = await this.store.db.select().from(remoteMachines);
    const now = this.clock();

    return rows
      .filter(
        (machine) =>
          (machine.capabilities ?? []).includes(REMOTE_BROWSER_CAPABILITY) &&
          present(machine.lastSeenAt, now) &&
          (!targetMachineId || machine.id === targetMachineId),
      )
      .sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))
      .map((machine) => ({ id: machine.id, name: machine.name }));
  }

  /**
   * Asks a machine's app to act in the browser beside a conversation. What it brings back can run
   * to megabytes, and only this caller needs it: it does not stay in the task's row.
   */
  async executeBrowser(
    profileId: string,
    machineId: string,
    params: RemoteBrowserParams,
    signal?: AbortSignal,
  ) {
    const data = remoteBrowserParamsSchema.parse(params);
    this.requireCurrent(await this.machine(machineId));
    const taskId = randomUUID();
    const result = await this.waitForTask(
      profileId,
      machineId,
      {
        kind: 'browser',
        command: '',
        cwd: null,
        payload: data,
        timeoutMs: BROWSER_TIMEOUT_MS,
      },
      signal,
      taskId,
    );
    const { browser, ...kept } = result;
    await this.store.db.update(remoteTasks).set({ result: kept }).where(eq(remoteTasks.id, taskId));
    return { ...kept, browser };
  }

  /** Whether a machine last advertised file operations; it need not be online right now. */
  async offersFiles(machineId: string): Promise<boolean> {
    const [machine] = await this.store.db
      .select({ capabilities: remoteMachines.capabilities })
      .from(remoteMachines)
      .where(eq(remoteMachines.id, machineId))
      .limit(1);
    return (machine?.capabilities ?? []).includes(REMOTE_FILES_CAPABILITY);
  }

  /**
   * Asks a machine to run one file operation and waits for its answer. A refusal by the machine
   * (not found, changed, too large) is an answer, returned for the caller to word; an answer
   * that does not match the request is the machine misbehaving. The file text a write sends and
   * a read brings back is in the caller's hands alone: neither stays in the task's row.
   */
  async executeFiles(
    profileId: string,
    machineId: string,
    input: RemoteFilesOp,
    signal?: AbortSignal,
    timeoutMs = 60_000,
  ): Promise<RemoteFilesAnswer> {
    const op = filesOp(input);
    const machine = await this.machine(machineId);
    if (!(machine.capabilities ?? []).includes(REMOTE_FILES_CAPABILITY)) {
      throw new GatewayError(
        409,
        `${machine.name} runs a Jian Remote too old to edit files. Update Jian Remote there.`,
      );
    }
    this.requireCurrent(machine);
    const taskId = randomUUID();
    let returned = false;
    try {
      const result = await this.waitForTask(
        profileId,
        machineId,
        { kind: 'files', command: '', cwd: null, payload: op, timeoutMs },
        signal,
        taskId,
      );
      // A task failed without an answer, by the restart sweep or as unusable, says why.
      if (result.files === undefined && result.stderr.trim()) {
        throw new GatewayError(502, result.stderr.trim());
      }
      const answer = remoteFilesAnswerSchema.safeParse(storedFiles(result.files));
      if (!answer.success || answer.data.op !== op.op) {
        throw new GatewayError(502, 'The machine answered something else.');
      }
      returned = true;
      return answer.data;
    } finally {
      // Whatever ends the call early, a late answer must not land in the row with its contents,
      // and a write the worker never claimed must not keep the text it was to write.
      if (!returned) {
        await this.store.db
          .update(remoteTasks)
          .set({ status: 'failed', updatedAt: new Date(this.clock()) })
          .where(
            and(eq(remoteTasks.id, taskId), inArray(remoteTasks.status, ['queued', 'running'])),
          )
          .catch(() => {});
        // A database error here must not hide why the call ended, nor skip the strip below.
        if (op.op === 'write' || op.op === 'write-bytes') {
          await this.store.db
            .update(remoteTasks)
            .set({ payload: withoutWrittenContent(op) })
            .where(eq(remoteTasks.id, taskId))
            .catch(() => {});
        }
      }
      await this.stripFileContents(taskId);
    }
  }

  /**
   * The files tasks whose callers are gone: each fails and gives up the file text it holds, and a
   * worker's late claim or answer is refused. A gateway that is the only process runs it at
   * start over every one, since a restart ended all its calls; a write queued just before is
   * dropped with the run that asked. Where other processes share the database (`givenUpOnly`),
   * a task is swept only once its caller has certainly stopped waiting: its limit and the 30 s
   * `waitForTask` allows past it are over.
   */
  async failLeftoverFiles({ givenUpOnly = false }: { givenUpOnly?: boolean } = {}) {
    const givenUp = givenUpOnly
      ? [
          sql`${remoteTasks.createdAt} + (${remoteTasks.timeoutMs} + 30000) * interval '1 millisecond' < ${new Date(this.clock()).toISOString()}::timestamptz`,
        ]
      : [];
    const rows = await this.store.db
      .select({ id: remoteTasks.id, status: remoteTasks.status, payload: remoteTasks.payload })
      .from(remoteTasks)
      .where(
        and(
          eq(remoteTasks.kind, 'files'),
          or(
            inArray(remoteTasks.status, ['queued', 'running']),
            // An answer its caller never read is still the JSON text `complete` stored.
            sql`jsonb_typeof(${remoteTasks.result} -> 'files') = 'string'`,
          ),
          ...givenUp,
        ),
      );
    for (const row of rows) {
      if (row.status === 'queued' || row.status === 'running') {
        await this.store.db
          .update(remoteTasks)
          .set({
            status: 'failed',
            payload: withoutWrittenContent(row.payload),
            result: {
              taskId: row.id,
              exitCode: null,
              stdout: '',
              stderr: 'The gateway restarted before the machine answered.',
              timedOut: false,
            },
            updatedAt: new Date(this.clock()),
          })
          .where(
            and(eq(remoteTasks.id, row.id), inArray(remoteTasks.status, ['queued', 'running'])),
          );
      }
      await this.stripFileContents(row.id);
    }
  }

  /** Removes file contents from a files task's stored answer, keeping its op, sizes and names. */
  private async stripFileContents(taskId: string) {
    const [row] = await this.store.db
      .select({ result: remoteTasks.result })
      .from(remoteTasks)
      .where(eq(remoteTasks.id, taskId))
      .limit(1);
    const result = row?.result as TaskResult | null | undefined;
    const files = storedFiles(result?.files);
    if (!result || !files || typeof files !== 'object') return;
    const kept = Object.fromEntries(
      Object.entries(files).filter(([key]) => !FILE_CONTENT_FIELDS.has(key)),
    );
    await this.store.db
      .update(remoteTasks)
      .set({ result: { ...result, files: kept } })
      .where(eq(remoteTasks.id, taskId));
  }

  async executeComputer(
    profileId: string,
    machineId: string,
    input: unknown,
    signal?: AbortSignal,
  ) {
    const data = remoteComputerCommandSchema.parse(input);
    const machine = await this.machine(machineId);
    if (!present(machine.lastSeenAt, this.clock())) {
      throw new GatewayError(503, 'Remote machine is offline');
    }
    this.requireCurrent(machine);
    // Do not soft-block on uiState=locked: the worker wakes the display and attempts the
    // action. Failures come back from the OS/API (or as a clear worker error).
    if (!machineSupportsComputer(machine)) {
      throw new GatewayError(
        503,
        'This remote machine does not support computer use yet. Update Jian Remote so the worker advertises computer-macos-v1, computer-linux-v1, or computer-windows-v1.',
      );
    }
    const { timeoutMs, ...computer } = data;
    return this.waitForTask(
      profileId,
      machineId,
      {
        kind: 'computer',
        command: '',
        cwd: null,
        payload: computer,
        timeoutMs,
      },
      signal,
    );
  }

  /**
   * Brings a machine's worker to this gateway's release (or the latest one, on a gateway with
   * none). The worker installs it, says how it went, then restarts on the new release. `profileId`
   * is the agent that asked, or null when the owner did from the panel.
   */
  async update(
    profileId: string | null,
    machineId: string,
    signal?: AbortSignal,
  ): Promise<RemoteMachineUpdate> {
    const machine = await this.machine(machineId);
    if (!present(machine.lastSeenAt, this.clock())) {
      throw new GatewayError(503, 'Remote machine is offline');
    }
    if (!machineCanUpdate(machine)) {
      throw new GatewayError(
        409,
        `${machine.name} cannot update itself: its Jian Remote was not installed with npm, or predates updates on request. On that computer, run: jian-remote update`,
      );
    }
    const version = this.release() ?? 'latest';
    if (machine.version === version) {
      return { ok: true, from: version, to: version, message: `Already on ${version}.` };
    }
    const result = await this.waitForTask(
      profileId,
      machineId,
      {
        kind: 'update',
        command: '',
        cwd: null,
        payload: { version } satisfies RemoteUpdateParams,
        timeoutMs: UPDATE_TIMEOUT_MS,
      },
      signal,
    );
    const ok = result.exitCode === 0 && !result.timedOut;
    return {
      ok,
      from: result.update?.from ?? machine.version,
      to: result.update?.to ?? null,
      message: ok
        ? result.stdout.trim() || `Updated to ${result.update?.to ?? version}.`
        : result.stderr.trim() || 'The update failed.',
    };
  }

  /** Agents get no work from a worker on another major.minor: it must be updated first. */
  private requireCurrent(machine: Machine): void {
    const release = this.release();
    if (!workerOutdated(machine.version, release)) return;
    throw new GatewayError(
      409,
      `${machine.name} runs Jian Remote ${machine.version}, which does not match this gateway (${release}). Update the machine first: update_remote_machine, or Update under Machines in the panel's settings.`,
    );
  }

  private async waitForTask(
    profileId: string | null,
    machineId: string,
    task: {
      kind: 'shell' | 'computer' | 'update' | 'browser' | 'files';
      command: string;
      cwd: string | null;
      payload:
        | RemoteComputerParams
        | RemoteBrowserParams
        | RemoteFilesOp
        | Record<string, unknown>
        | null;
      timeoutMs: number;
    },
    signal?: AbortSignal,
    taskId: string = randomUUID(),
  ): Promise<TaskResult> {
    const now = new Date(this.clock());
    await this.store.db.insert(remoteTasks).values({
      id: taskId,
      machineId,
      profileId,
      kind: task.kind,
      command: task.command,
      cwd: task.cwd,
      payload: task.payload,
      timeoutMs: task.timeoutMs,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    const deadline = this.clock() + task.timeoutMs + 30_000;
    while (this.clock() < deadline) {
      if (signal?.aborted) {
        await this.store.db
          .update(remoteTasks)
          .set({
            status: 'failed',
            result: {
              taskId,
              exitCode: null,
              stdout: '',
              stderr: 'Remote command was cancelled',
              timedOut: false,
            },
            updatedAt: new Date(this.clock()),
          })
          .where(and(eq(remoteTasks.id, taskId), eq(remoteTasks.status, 'queued')));
        throw new GatewayError(499, 'Remote command was cancelled');
      }
      const [row] = await this.store.db
        .select()
        .from(remoteTasks)
        .where(eq(remoteTasks.id, taskId))
        .limit(1);
      if (row?.status === 'completed' || row?.status === 'failed') {
        const result = row.result as TaskResult | null;
        return (
          result ?? {
            taskId,
            exitCode: null,
            stdout: '',
            stderr: 'Remote task failed',
            timedOut: false,
          }
        );
      }
      // A worker running the task does not poll meanwhile, so silence counts only before it
      // claims it; once running, the task's own deadline decides.
      const [heartbeat] = await this.store.db
        .select({ lastSeenAt: remoteMachines.lastSeenAt })
        .from(remoteMachines)
        .where(eq(remoteMachines.id, machineId))
        .limit(1);
      const silent =
        !heartbeat?.lastSeenAt || this.clock() - heartbeat.lastSeenAt.getTime() > 60_000;
      if (row?.status === 'queued' && silent) {
        await this.store.db
          .delete(remoteTasks)
          .where(and(eq(remoteTasks.id, taskId), eq(remoteTasks.status, 'queued')));
        throw new GatewayError(503, 'Remote machine is offline');
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.store.db
      .update(remoteTasks)
      .set({
        status: 'failed',
        result: {
          exitCode: null,
          stdout: '',
          stderr: 'Remote command timed out waiting for the machine',
          timedOut: true,
        },
        updatedAt: new Date(this.clock()),
      })
      .where(and(eq(remoteTasks.id, taskId), inArray(remoteTasks.status, ['queued', 'running'])));
    throw new GatewayError(504, 'Remote command timed out');
  }

  async poll(
    machineId: string,
    authorization: string,
    reportedPlatform?: string | undefined,
    capabilitiesHeader?: string | undefined,
    uiStateHeader?: string | undefined,
    versionHeader?: string | undefined,
    systemHeader?: string | undefined,
  ) {
    const machine = await this.authenticate(machineId, authorization);
    const platform = remotePlatformSchema.safeParse(reportedPlatform).data ?? machine.platform;
    const capabilities = parseCapabilities(capabilitiesHeader);
    const uiState = parseUiState(uiStateHeader);
    const version = parseVersion(versionHeader) ?? machine.version;
    // A worker from before it reported its system, or one that could not tell, keeps the last.
    const system = parseSystem(systemHeader) ?? machine.system;
    await this.store.db
      .update(remoteMachines)
      .set({
        lastSeenAt: new Date(this.clock()),
        platform,
        capabilities,
        uiState,
        version,
        system,
      })
      .where(eq(remoteMachines.id, machineId));
    // A worker on another major.minor is handed nothing but its update.
    const outdated = workerOutdated(version, this.release());
    const [next] = await this.store.db
      .select()
      .from(remoteTasks)
      .where(
        and(
          eq(remoteTasks.machineId, machineId),
          eq(remoteTasks.status, 'queued'),
          ...(outdated ? [eq(remoteTasks.kind, 'update')] : []),
        ),
      )
      .orderBy(asc(remoteTasks.createdAt))
      .limit(1);
    if (!next) return { task: null };
    const [claimed] = await this.store.db
      .update(remoteTasks)
      .set({ status: 'running', updatedAt: new Date(this.clock()) })
      .where(and(eq(remoteTasks.id, next.id), eq(remoteTasks.status, 'queued')))
      .returning();
    if (!claimed) return { task: null };
    const kind = claimed.kind ?? 'shell';
    if (kind === 'update') {
      const parsed = remoteUpdateParamsSchema.safeParse(claimed.payload);
      if (!parsed.success) {
        await this.failClaimed(claimed.id, 'Invalid update payload');
        return { task: null };
      }
      return {
        task: {
          id: claimed.id,
          kind: 'update' as const,
          command: null,
          cwd: null,
          timeoutMs: claimed.timeoutMs,
          update: parsed.data,
        },
      };
    }
    if (kind === 'browser') {
      const parsed = remoteBrowserParamsSchema.safeParse(claimed.payload);
      if (!parsed.success) {
        await this.failClaimed(claimed.id, 'Invalid browser payload');
        return { task: null };
      }
      return {
        task: {
          id: claimed.id,
          kind: 'browser' as const,
          command: null,
          cwd: null,
          timeoutMs: claimed.timeoutMs,
          browser: parsed.data,
        },
      };
    }
    if (kind === 'files') {
      const parsed = remoteFilesOpSchema.safeParse(claimed.payload);
      if (!parsed.success) {
        await this.failClaimed(claimed.id, 'Invalid files payload');
        return { task: null };
      }
      // What a write carries is the caller's file text: the worker has it now, the row need not.
      if (parsed.data.op === 'write' || parsed.data.op === 'write-bytes') {
        await this.store.db
          .update(remoteTasks)
          .set({ payload: withoutWrittenContent(claimed.payload) })
          .where(eq(remoteTasks.id, claimed.id));
      }
      return {
        task: {
          id: claimed.id,
          kind: 'files' as const,
          command: null,
          cwd: null,
          timeoutMs: claimed.timeoutMs,
          files: parsed.data,
        },
      };
    }
    if (kind === 'computer') {
      const parsed = remoteComputerParamsSchema.safeParse(claimed.payload);
      if (!parsed.success) {
        await this.failClaimed(claimed.id, 'Invalid computer-use payload');
        return { task: null };
      }
      return {
        task: {
          id: claimed.id,
          kind: 'computer' as const,
          command: null,
          cwd: null,
          timeoutMs: claimed.timeoutMs,
          computer: parsed.data,
        },
      };
    }
    const env = await this.claimSecretEnv(claimed.id, claimed.payload);
    if (env === null) {
      await this.failClaimed(claimed.id, 'The credentials of this command are gone; run it again.');
      return { task: null };
    }
    return {
      task: {
        id: claimed.id,
        kind: 'shell' as const,
        command: claimed.command,
        cwd: claimed.cwd,
        timeoutMs: claimed.timeoutMs,
        ...(env ? { env } : {}),
      },
    };
  }

  /**
   * The secret environment of a claimed shell task, taken out of the vault as it is handed
   * over, so it exists only in the worker from then on. Undefined when the task has none; null
   * when it should and it is gone.
   */
  private async claimSecretEnv(
    taskId: string,
    payload: Record<string, unknown> | null,
  ): Promise<Record<string, string> | null | undefined> {
    const names = payload?.env;
    if (!Array.isArray(names) || !names.length) return undefined;
    const stored = await this.vault?.read(secretEnvKey(taskId));
    await this.vault?.discard(secretEnvKey(taskId));
    if (!stored) return null;
    const values = JSON.parse(stored) as Record<string, unknown>;
    const env: Record<string, string> = {};
    for (const name of names) {
      if (typeof name === 'string' && typeof values[name] === 'string') env[name] = values[name];
    }
    return env;
  }

  /** The worker is stopping: offline now, rather than when its last poll grows old. */
  async disconnect(machineId: string, authorization: string) {
    await this.authenticate(machineId, authorization);
    await this.store.db
      .update(remoteMachines)
      .set({ lastSeenAt: null })
      .where(eq(remoteMachines.id, machineId));
    return { ok: true as const };
  }

  /** A claimed task whose payload the worker could not use: it fails without reaching it. */
  private async failClaimed(taskId: string, message: string) {
    await this.store.db
      .update(remoteTasks)
      .set({
        status: 'failed',
        result: { taskId, exitCode: 1, stdout: '', stderr: message, timedOut: false },
        updatedAt: new Date(this.clock()),
      })
      .where(eq(remoteTasks.id, taskId));
  }

  async complete(machineId: string, taskId: string, authorization: string, input: unknown) {
    await this.authenticate(machineId, authorization);
    const result = remoteResultSchema.parse(input);
    if (result.taskId !== taskId) throw new GatewayError(400, 'Task id mismatch');
    // Postgres keeps no U+0000 in jsonb, and git's `-z` outputs are made of it: a files answer
    // waits in the row as its JSON text, where every NUL is escaped, until its caller reads it.
    const kept =
      result.files === undefined ? result : { ...result, files: JSON.stringify(result.files) };
    const [task] = await this.store.db
      .update(remoteTasks)
      .set({ status: 'completed', result: kept, updatedAt: new Date(this.clock()) })
      .where(
        and(
          eq(remoteTasks.id, taskId),
          eq(remoteTasks.machineId, machineId),
          eq(remoteTasks.status, 'running'),
        ),
      )
      .returning({ id: remoteTasks.id });
    if (!task) throw new GatewayError(404, 'Running remote task not found');
    return { ok: true as const };
  }

  /** Every agent may use every machine; only an unknown one is refused. */
  private async machine(machineId: string) {
    const [machine] = await this.store.db
      .select()
      .from(remoteMachines)
      .where(eq(remoteMachines.id, machineId))
      .limit(1);
    if (!machine) throw new GatewayError(404, 'Remote machine not found');
    return machine;
  }

  private async authenticate(machineId: string, authorization: string) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(authorization);
    const token = match?.[1];
    const [machine] = await this.store.db
      .select()
      .from(remoteMachines)
      .where(eq(remoteMachines.id, machineId))
      .limit(1);
    if (!machine || !token) throw new GatewayError(401, 'Unauthorized');
    const actual = Buffer.from(tokenHash(token));
    const expected = Buffer.from(machine.tokenHash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new GatewayError(401, 'Unauthorized');
    return machine;
  }
}

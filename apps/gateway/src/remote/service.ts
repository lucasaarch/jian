import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type RemoteComputerParams,
  type RemoteMachineUpdate,
  type RemoteUpdateParams,
  remoteCommandSchema,
  remoteComputerCommandSchema,
  remoteComputerParamsSchema,
  remoteMachineCreateSchema,
  remoteResultSchema,
  remoteUpdateParamsSchema,
} from '@jian/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import { gatewayRelease, workerOutdated } from '../core/release.js';
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

/** npm and the handover to the new worker can take minutes on a slow link, in ms. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;

type Machine = typeof remoteMachines.$inferSelect;
type TaskResult = {
  taskId?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  computer?: unknown;
  update?: { from: string; to: string };
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

function publicMachine(
  machine: Machine,
  now: number,
  release: string | undefined,
): {
  id: string;
  name: string;
  platform: string;
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
    const platform = 'unknown';
    await this.store.db.insert(remoteMachines).values({
      id,
      name: data.name,
      platform,
      tokenHash: tokenHash(token),
      capabilities: [],
      createdAt,
    });
    return {
      id,
      name: data.name,
      platform,
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

  async execute(profileId: string, machineId: string, input: unknown, signal?: AbortSignal) {
    const data = remoteCommandSchema.parse(input);
    this.requireCurrent(await this.machine(machineId));
    return this.waitForTask(
      profileId,
      machineId,
      {
        kind: 'shell',
        command: data.command,
        cwd: data.cwd ?? null,
        payload: null,
        timeoutMs: data.timeoutMs,
      },
      signal,
    );
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
      `${machine.name} runs Jian Remote ${machine.version}, which does not match this gateway (${release}). Update the machine first: update_remote_machine, or Update in the panel's Remote Control settings.`,
    );
  }

  private async waitForTask(
    profileId: string | null,
    machineId: string,
    task: {
      kind: 'shell' | 'computer' | 'update';
      command: string;
      cwd: string | null;
      payload: RemoteComputerParams | Record<string, unknown> | null;
      timeoutMs: number;
    },
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    const taskId = randomUUID();
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
  ) {
    const machine = await this.authenticate(machineId, authorization);
    const platform =
      reportedPlatform && /^(darwin|linux|win32)-(arm64|x64)$/.test(reportedPlatform)
        ? reportedPlatform
        : machine.platform;
    const capabilities = parseCapabilities(capabilitiesHeader);
    const uiState = parseUiState(uiStateHeader);
    const version = parseVersion(versionHeader) ?? machine.version;
    await this.store.db
      .update(remoteMachines)
      .set({
        lastSeenAt: new Date(this.clock()),
        platform,
        capabilities,
        uiState,
        version,
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
    return {
      task: {
        id: claimed.id,
        kind: 'shell' as const,
        command: claimed.command,
        cwd: claimed.cwd,
        timeoutMs: claimed.timeoutMs,
      },
    };
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
    const [task] = await this.store.db
      .update(remoteTasks)
      .set({ status: 'completed', result, updatedAt: new Date(this.clock()) })
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

export const REMOTE_CAPABILITY_COMPUTER_MACOS = 'computer-macos-v1';
export const REMOTE_COMPUTER_CAPABILITIES = [
  'computer-macos-v1',
  'computer-linux-v1',
  'computer-windows-v1',
] as const;

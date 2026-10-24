import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type RemoteComputerParams,
  remoteCommandSchema,
  remoteComputerCommandSchema,
  remoteComputerParamsSchema,
  remoteMachineAccessSchema,
  remoteMachineCreateSchema,
  remoteResultSchema,
} from '@jian/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import { requireProfileCapability } from '../professions/effective.js';
import { findProfile } from '../profiles/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import { profiles, remoteMachines, remoteTasks } from '../storage/schema.js';

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

function publicMachine(
  machine: typeof remoteMachines.$inferSelect,
  now: number,
): {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  allowedProfileIds: string[];
  createdAt: string;
  capabilities: string[];
  uiState: RemoteUiState;
} {
  return {
    id: machine.id,
    name: machine.name,
    platform: machine.platform,
    online: present(machine.lastSeenAt, now),
    allowedProfileIds: machine.allowedProfileIds,
    createdAt: machine.createdAt.toISOString(),
    capabilities: machine.capabilities ?? [],
    uiState: parseUiState(machine.uiState),
  };
}

export class Remote {
  constructor(
    private store: Store,
    private clock: () => number = Date.now,
  ) {}

  async list() {
    const rows = await this.store.db
      .select()
      .from(remoteMachines)
      .orderBy(asc(remoteMachines.createdAt));
    const now = this.clock();
    return rows.map((machine) => publicMachine(machine, now));
  }

  async create(input: unknown) {
    const data = remoteMachineCreateSchema.parse(input);
    await this.assertProfiles(data.allowedProfileIds);
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const createdAt = new Date(this.clock());
    const platform = 'unknown';
    await this.store.db.insert(remoteMachines).values({
      id,
      name: data.name,
      platform,
      tokenHash: tokenHash(token),
      allowedProfileIds: data.allowedProfileIds,
      capabilities: [],
      createdAt,
    });
    return {
      id,
      name: data.name,
      platform,
      online: false,
      allowedProfileIds: data.allowedProfileIds,
      createdAt: createdAt.toISOString(),
      capabilities: [] as string[],
      uiState: 'unknown' as const,
      token,
    };
  }

  async setAccess(machineId: string, input: unknown) {
    const { allowedProfileIds } = remoteMachineAccessSchema.parse(input);
    await this.assertProfiles(allowedProfileIds);
    const [machine] = await this.store.db
      .update(remoteMachines)
      .set({ allowedProfileIds })
      .where(eq(remoteMachines.id, machineId))
      .returning();
    if (!machine) throw new GatewayError(404, 'Remote machine not found');
    return publicMachine(machine, this.clock());
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
    return { ...publicMachine(machine, this.clock()), token };
  }

  async remove(machineId: string) {
    // Never acquire profile locks here: admission holds its profile lock before
    // taking the machine row lock. The row lock serializes its check/insert with deletion.
    return this.store.transaction(`remote-machine:${machineId}`, async (tx) => {
      const [machine] = await tx
        .select({ id: remoteMachines.id })
        .from(remoteMachines)
        .where(eq(remoteMachines.id, machineId))
        .limit(1)
        .for('update');
      if (!machine) throw new GatewayError(404, 'Remote machine not found');
      const [pending] = await tx
        .select({ id: remoteTasks.id })
        .from(remoteTasks)
        .where(
          and(
            eq(remoteTasks.machineId, machineId),
            inArray(remoteTasks.status, ['queued', 'running']),
          ),
        )
        .limit(1);
      if (pending) throw new GatewayError(409, 'Remote machine has queued or running tasks');
      await tx.delete(remoteMachines).where(eq(remoteMachines.id, machineId));
      return machine;
    });
  }

  async listForProfile(profileId: string) {
    await this.requireRemoteCapability(profileId);
    const rows = await this.store.db
      .select()
      .from(remoteMachines)
      .orderBy(asc(remoteMachines.createdAt));
    const now = this.clock();
    return rows
      .filter((machine) => machine.allowedProfileIds.includes(profileId))
      .map((machine) => publicMachine(machine, now));
  }

  async execute(profileId: string, machineId: string, input: unknown, signal?: AbortSignal) {
    const data = remoteCommandSchema.parse(input);
    await this.machineForProfile(profileId, machineId);
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
    const machine = await this.machineForProfile(profileId, machineId);
    if (!present(machine.lastSeenAt, this.clock())) {
      throw new GatewayError(503, 'Remote machine is offline');
    }
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

  private async waitForTask(
    profileId: string,
    machineId: string,
    task: {
      kind: 'shell' | 'computer';
      command: string;
      cwd: string | null;
      payload: RemoteComputerParams | Record<string, unknown> | null;
      timeoutMs: number;
    },
    signal?: AbortSignal,
  ) {
    const taskId = randomUUID();
    await this.store.transaction(profileId, async (tx) => {
      // Earlier checks are only a fast rejection, not authority to admit work.
      await this.machineForProfile(profileId, machineId, tx, true);
      const now = new Date(this.clock());
      await tx.insert(remoteTasks).values({
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
    });
    // Waiting on a remote worker must never hold the profile lock.

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
        const result = row.result as {
          exitCode: number | null;
          stdout: string;
          stderr: string;
          timedOut: boolean;
          computer?: unknown;
        } | null;
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
      const [heartbeat] = await this.store.db
        .select({ lastSeenAt: remoteMachines.lastSeenAt })
        .from(remoteMachines)
        .where(eq(remoteMachines.id, machineId))
        .limit(1);
      if (!heartbeat?.lastSeenAt || this.clock() - heartbeat.lastSeenAt.getTime() > 60_000) {
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
      // A gateway timeout does not prove that the worker stopped. Keep running work
      // unsettled until its authenticated completion, even after the caller has left.
      .where(and(eq(remoteTasks.id, taskId), eq(remoteTasks.status, 'queued')));
    throw new GatewayError(504, 'Remote command timed out');
  }

  async poll(
    machineId: string,
    authorization: string,
    reportedPlatform?: string | undefined,
    capabilitiesHeader?: string | undefined,
    uiStateHeader?: string | undefined,
  ) {
    const machine = await this.authenticate(machineId, authorization);
    const platform =
      reportedPlatform && /^(darwin|linux|win32)-(arm64|x64)$/.test(reportedPlatform)
        ? reportedPlatform
        : machine.platform;
    const capabilities = parseCapabilities(capabilitiesHeader);
    const uiState = parseUiState(uiStateHeader);
    await this.store.db
      .update(remoteMachines)
      .set({
        lastSeenAt: new Date(this.clock()),
        platform,
        capabilities,
        uiState,
      })
      .where(eq(remoteMachines.id, machineId));
    if (!machine.allowedProfileIds.length) return { task: null };
    const tasks = await this.store.db
      .select()
      .from(remoteTasks)
      .where(
        and(
          eq(remoteTasks.machineId, machineId),
          eq(remoteTasks.status, 'queued'),
          inArray(remoteTasks.profileId, machine.allowedProfileIds),
        ),
      )
      .orderBy(asc(remoteTasks.createdAt))
      .limit(20);
    let claimed: (typeof tasks)[number] | undefined;
    for (const task of tasks) {
      claimed = await this.store.transaction(task.profileId, async (tx) => {
        // The candidate snapshot is not a grant. Recheck live ACL and profile under
        // the same lock as the queued -> running transition.
        const liveMachine = await this.authenticate(machineId, authorization, tx, true);
        if (!liveMachine.allowedProfileIds.includes(task.profileId)) return undefined;
        // A queued remote command belongs to the profile's durable work queue. Do not fail it
        // during upgrade; leave it queued until the owner chooses a profession.
        if ((await findProfile(tx, task.profileId))?.professionId === null) return undefined;
        try {
          await this.requireRemoteCapability(task.profileId, tx);
        } catch (error) {
          if (!(error instanceof GatewayError)) throw error;
          await tx
            .update(remoteTasks)
            .set({
              status: 'failed',
              result: {
                taskId: task.id,
                exitCode: null,
                stdout: '',
                stderr: error.message,
                timedOut: false,
              },
              updatedAt: new Date(this.clock()),
            })
            .where(and(eq(remoteTasks.id, task.id), eq(remoteTasks.status, 'queued')));
          return undefined;
        }
        const [row] = await tx
          .update(remoteTasks)
          .set({ status: 'running', updatedAt: new Date(this.clock()) })
          .where(and(eq(remoteTasks.id, task.id), eq(remoteTasks.status, 'queued')))
          .returning();
        return row;
      });
      if (claimed) break;
    }
    if (!claimed) return { task: null };
    const kind = claimed.kind ?? 'shell';
    if (kind === 'computer') {
      const parsed = remoteComputerParamsSchema.safeParse(claimed.payload);
      if (!parsed.success) {
        await this.store.db
          .update(remoteTasks)
          .set({
            status: 'failed',
            result: {
              taskId: claimed.id,
              exitCode: 1,
              stdout: '',
              stderr: 'Invalid computer-use payload',
              timedOut: false,
            },
            updatedAt: new Date(this.clock()),
          })
          .where(eq(remoteTasks.id, claimed.id));
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

  async workerUpdateAuthorized(machineId: string, authorization: string) {
    await this.authenticate(machineId, authorization);
  }

  async complete(machineId: string, taskId: string, authorization: string, input: unknown) {
    return this.store.transaction(`remote-machine:${machineId}`, async (tx) => {
      // Token rotation must not overtake authentication before the completion write.
      // ACL revocation is not a reason to discard a still-authenticated completion.
      await this.authenticate(machineId, authorization, tx, true);
      const result = remoteResultSchema.parse(input);
      if (result.taskId !== taskId) throw new GatewayError(400, 'Task id mismatch');
      const [task] = await tx
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
    });
  }

  private async requireRemoteCapability(profileId: string, db: Queryable = this.store.db) {
    const profile = await findProfile(db, profileId);
    if (!profile) throw new GatewayError(404, 'Profile not found');
    requireProfileCapability(profile, 'remote.control');
  }

  private async machineForProfile(
    profileId: string,
    machineId: string,
    db: Queryable = this.store.db,
    lockForAdmission = false,
  ) {
    await this.requireRemoteCapability(profileId, db);
    const query = db.select().from(remoteMachines).where(eq(remoteMachines.id, machineId)).limit(1);
    const [machine] = await (lockForAdmission ? query.for('share') : query);
    if (!machine?.allowedProfileIds.includes(profileId))
      throw new GatewayError(403, 'This profile is not allowed to use that remote machine');
    return machine;
  }

  private async authenticate(
    machineId: string,
    authorization: string,
    db: Queryable = this.store.db,
    lockForMutation = false,
  ) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(authorization);
    const token = match?.[1];
    const query = db.select().from(remoteMachines).where(eq(remoteMachines.id, machineId)).limit(1);
    const [machine] = await (lockForMutation ? query.for('share') : query);
    if (!machine || !token) throw new GatewayError(401, 'Unauthorized');
    const actual = Buffer.from(tokenHash(token));
    const expected = Buffer.from(machine.tokenHash);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new GatewayError(401, 'Unauthorized');
    return machine;
  }

  private async assertProfiles(ids: string[]) {
    const unique = new Set(ids);
    if (unique.size !== ids.length) throw new GatewayError(400, 'Profile ids must be unique');
    const rows = ids.length
      ? await this.store.db
          .select({ id: profiles.id })
          .from(profiles)
          .where(inArray(profiles.id, ids))
      : [];
    if (rows.length !== ids.length)
      throw new GatewayError(404, 'One or more profiles were not found');
  }
}

export const REMOTE_CAPABILITY_COMPUTER_MACOS = 'computer-macos-v1';
export const REMOTE_COMPUTER_CAPABILITIES = [
  'computer-macos-v1',
  'computer-linux-v1',
  'computer-windows-v1',
] as const;

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  remoteCommandSchema,
  remoteMachineAccessSchema,
  remoteMachineCreateSchema,
  remoteResultSchema,
} from '@jian/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import type { Store } from '../storage/database.js';
import { profiles, remoteMachines, remoteTasks } from '../storage/schema.js';

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const present = (lastSeen: Date | null, now: number) =>
  !!lastSeen && now - lastSeen.getTime() < 60_000;

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
    return rows.map(({ tokenHash: _secret, lastSeenAt, ...machine }) => ({
      ...machine,
      online: present(lastSeenAt, this.clock()),
    }));
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
      createdAt,
    });
    return {
      id,
      name: data.name,
      platform,
      online: false,
      allowedProfileIds: data.allowedProfileIds,
      createdAt: createdAt.toISOString(),
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
    return {
      id: machine.id,
      name: machine.name,
      platform: machine.platform,
      online: present(machine.lastSeenAt, this.clock()),
      allowedProfileIds: machine.allowedProfileIds,
      createdAt: machine.createdAt.toISOString(),
    };
  }

  async remove(machineId: string) {
    const [machine] = await this.store.db
      .delete(remoteMachines)
      .where(eq(remoteMachines.id, machineId))
      .returning({ id: remoteMachines.id });
    if (!machine) throw new GatewayError(404, 'Remote machine not found');
    return machine;
  }

  async listForProfile(profileId: string) {
    const rows = await this.store.db
      .select()
      .from(remoteMachines)
      .orderBy(asc(remoteMachines.createdAt));
    return rows
      .filter((machine) => machine.allowedProfileIds.includes(profileId))
      .map(({ tokenHash: _secret, lastSeenAt, ...machine }) => ({
        ...machine,
        online: present(lastSeenAt, this.clock()),
      }));
  }

  async execute(profileId: string, machineId: string, input: unknown, signal?: AbortSignal) {
    const data = remoteCommandSchema.parse(input);
    await this.machineForProfile(profileId, machineId);
    const taskId = randomUUID();
    const now = new Date(this.clock());
    await this.store.db.insert(remoteTasks).values({
      id: taskId,
      machineId,
      profileId,
      command: data.command,
      cwd: data.cwd ?? null,
      timeoutMs: data.timeoutMs,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    const deadline = this.clock() + data.timeoutMs + 30_000;
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
      const [task] = await this.store.db
        .select()
        .from(remoteTasks)
        .where(eq(remoteTasks.id, taskId))
        .limit(1);
      if (task?.status === 'completed' || task?.status === 'failed') {
        const result = task.result as {
          exitCode: number | null;
          stdout: string;
          stderr: string;
          timedOut: boolean;
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
      .where(and(eq(remoteTasks.id, taskId), inArray(remoteTasks.status, ['queued', 'running'])));
    throw new GatewayError(504, 'Remote command timed out');
  }

  async poll(machineId: string, authorization: string, reportedPlatform: string | undefined) {
    const machine = await this.authenticate(machineId, authorization);
    const platform =
      reportedPlatform && /^(darwin|linux)-(arm64|x64)$/.test(reportedPlatform)
        ? reportedPlatform
        : machine.platform;
    await this.store.db
      .update(remoteMachines)
      .set({ lastSeenAt: new Date(this.clock()), platform })
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
    const next = tasks.find((task) => machine.allowedProfileIds.includes(task.profileId));
    if (!next) return { task: null };
    const [claimed] = await this.store.db
      .update(remoteTasks)
      .set({ status: 'running', updatedAt: new Date(this.clock()) })
      .where(and(eq(remoteTasks.id, next.id), eq(remoteTasks.status, 'queued')))
      .returning();
    if (!claimed) return { task: null };
    return {
      task: {
        id: claimed.id,
        command: claimed.command,
        cwd: claimed.cwd,
        timeoutMs: claimed.timeoutMs,
      },
    };
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

  private async machineForProfile(profileId: string, machineId: string) {
    const [machine] = await this.store.db
      .select()
      .from(remoteMachines)
      .where(eq(remoteMachines.id, machineId))
      .limit(1);
    if (!machine?.allowedProfileIds.includes(profileId))
      throw new GatewayError(403, 'This profile is not allowed to use that remote machine');
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

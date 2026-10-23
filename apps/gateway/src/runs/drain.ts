import { setTimeout as sleep } from 'node:timers/promises';
import type { Run } from '@jian/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Queryable, Store } from '../storage/database.js';
import { deploymentDrain, deploymentDrainGenerations, runs } from '../storage/schema.js';

const drainScope = 'jian:deployment-drain';
// Diagnostic timestamps only. Neither an expired hook nor an expired executor proves safety.
export const DRAIN_LEASE_MS = 30_000;
export const EXECUTION_LEASE_MS = 60_000;

/** Profile lock -> this fence -> run writes. Never acquire a profile lock under this fence. */
export async function lockDrainFence(tx: Queryable) {
  await tx.insert(deploymentDrain).values({ id: 1 }).onConflictDoNothing();
  const [state] = await tx
    .select()
    .from(deploymentDrain)
    .where(eq(deploymentDrain.id, 1))
    .for('update');
  if (!state) throw new Error('Drain fence missing');
  return { ...state, active: state.owner !== null };
}

export async function queuesInbound(tx: Queryable): Promise<boolean> {
  return (await lockDrainFence(tx)).active;
}

/** A human answer retains peer addressing, but is new ingress, not an existing dependency. */
export function drainDependency(run: Run): boolean {
  return Boolean(run.call || run.subagent) && !run.requestKey.startsWith('ask-answer:');
}

/** Held until claim's queued -> running write and execution marker have committed. */
export async function admitsRun(tx: Queryable, run: Run): Promise<boolean> {
  const state = await lockDrainFence(tx);
  return !state.active || (state.phase === 'draining' && drainDependency(run));
}

function generationId(value: string): string {
  if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(value))
    throw new Error('A deployment generation is required');
  return value;
}

export class DeploymentDrain {
  constructor(private readonly store: Store) {}

  /** Repeated hooks for the same active generation are idempotent; consumed IDs never restart. */
  async request(generation: string) {
    generationId(generation);
    await this.store.transaction(drainScope, async (tx) => {
      const state = await lockDrainFence(tx);
      if (state.active) {
        if (state.owner === generation) return;
        throw new Error('Another deployment drain is active');
      }
      const inserted = await tx
        .insert(deploymentDrainGenerations)
        .values({ id: generation })
        .onConflictDoNothing()
        .returning({ id: deploymentDrainGenerations.id });
      if (!inserted.length) throw new Error('Deployment generation already consumed');
      await tx
        .update(deploymentDrain)
        .set({
          owner: generation,
          phase: 'draining',
          expiresAt: sql`clock_timestamp() + ${DRAIN_LEASE_MS} * interval '1 millisecond'`,
        })
        .where(eq(deploymentDrain.id, 1));
    });
  }

  /** Zero and holding commit under the same fence as claim. There is NO timed release. */
  async poll(generation: string): Promise<boolean> {
    return this.store.transaction(drainScope, async (tx) => {
      const state = await lockDrainFence(tx);
      if (!state.active || state.owner !== generation)
        throw new Error('Deployment generation lost');
      if (state.phase === 'holding') return true;
      const [busy] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(sql`
        ${runs.status} = 'running' OR ${runs.executionOwner} IS NOT NULL
        OR (${runs.status} = 'queued' AND (${runs.call} IS NOT NULL OR ${runs.subagent} IS NOT NULL)
          AND ${runs.requestKey} NOT LIKE 'ask-answer:%')
      `)
        .limit(1);
      await tx
        .update(deploymentDrain)
        .set({
          phase: busy ? 'draining' : 'holding',
          expiresAt: busy
            ? sql`clock_timestamp() + ${DRAIN_LEASE_MS} * interval '1 millisecond'`
            : null,
        })
        .where(eq(deploymentDrain.id, 1));
      return !busy;
    });
  }

  /** Operator-only: cancel/finish every pending swap BEFORE releasing its exact generation. */
  async release(generation: string): Promise<boolean> {
    generationId(generation);
    return this.store.transaction(drainScope, async (tx) => {
      const state = await lockDrainFence(tx);
      if (state.owner !== generation) return false;
      await tx
        .update(deploymentDrainGenerations)
        .set({ releasedAt: sql`clock_timestamp()` })
        .where(eq(deploymentDrainGenerations.id, generation));
      await tx
        .update(deploymentDrain)
        .set({ owner: null, phase: null, expiresAt: null })
        .where(and(eq(deploymentDrain.id, 1), eq(deploymentDrain.owner, generation)));
      return true;
    });
  }
}

export type DrainOptions = { timeoutMs: number; generation: string };

export function drainOptions(args: string[], environmentGeneration?: string): DrainOptions {
  const options = { timeoutMs: 480_000, generation: environmentGeneration ?? '' };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !value || seen.has(flag)) throw new Error('Invalid drain arguments');
    seen.add(flag);
    if (flag === '--generation') options.generation = generationId(value);
    else if (flag === '--timeout-seconds' && /^\d+$/.test(value)) {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
        throw new Error('Invalid timeout');
      options.timeoutMs = seconds * 1000;
    } else throw new Error('Invalid drain arguments');
  }
  generationId(options.generation);
  return options;
}

/** Every uncertain outcome stays closed. Recovery is explicit, never an expiry or catch handler. */
export async function predeployDrain(
  drain: DeploymentDrain,
  options: DrainOptions,
  signal: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + options.timeoutMs;
  signal.throwIfAborted();
  await drain.request(options.generation);
  for (;;) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('Deployment drain timed out');
    const held = await drain.poll(options.generation);
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('Deployment drain timed out');
    if (held) return;
    await sleep(Math.min(1000, Math.max(1, deadline - performance.now())), undefined, { signal });
  }
}

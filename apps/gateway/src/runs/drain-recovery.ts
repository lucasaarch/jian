import { and, eq, isNotNull } from 'drizzle-orm';
import { recordEvent } from '../core/events.js';
import type { Store } from '../storage/database.js';
import { deploymentDrain, runs } from '../storage/schema.js';
import { lockDrainFence } from './drain.js';

/** Internal operator interface, not exposed to model tools or HTTP. Assertions are out-of-band. */
export class DrainRecovery {
  constructor(private readonly store: Store) {}

  async inspect() {
    const [drain] = await this.store.db.select().from(deploymentDrain);
    const executions = await this.store.db
      .select({
        runId: runs.id,
        profileId: runs.profileId,
        status: runs.status,
        executionOwner: runs.executionOwner,
        diagnosticUntil: runs.executionUntil,
      })
      .from(runs)
      .where(isNotNull(runs.executionOwner));
    // Diagnostic snapshot only: never interpret absent/expired markers as a swap acknowledgement.
    return { drain: drain ?? null, executions };
  }

  /** The operator has positively stopped this exact executor; timeouts are not that proof. */
  async reconcileExecution(generation: string, runId: string, executionOwner: string) {
    const [address] = await this.store.db
      .select({ profileId: runs.profileId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!address) throw new Error('Execution not found');
    return this.store.transaction(address.profileId, async (tx) => {
      const gate = await lockDrainFence(tx);
      if (!gate.active || gate.owner !== generation)
        throw new Error('Deployment generation mismatch');
      const [run] = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.executionOwner, executionOwner)));
      if (!run) throw new Error('Execution owner mismatch');
      const error =
        'Executor explicitly reconciled after operator-confirmed stop. Inspect effects before continuing.';
      await tx
        .update(runs)
        .set({
          executionOwner: null,
          executionUntil: null,
          ...(run.status === 'running'
            ? {
                status: 'interrupted' as const,
                error,
                leaseOwner: null,
                leaseUntil: null,
              }
            : {}),
        })
        .where(and(eq(runs.id, runId), eq(runs.executionOwner, executionOwner)));
      await recordEvent(
        tx,
        Date.now,
        address.profileId,
        'run.execution-reconciled',
        {
          generation,
          executionOwner,
          previousStatus: run.status,
          assertion: 'operator-confirmed-executor-stopped',
        },
        runId,
      );
      return { runId, reconciled: true };
    });
  }
}

export type RecoveryOptions =
  | { action: 'inspect' }
  | { action: 'release'; generation: string }
  | { action: 'reconcile'; generation: string; runId: string; executionOwner: string };

export function recoveryOptions(args: string[]): RecoveryOptions {
  if (!args.length || (args.length === 1 && args[0] === 'inspect')) return { action: 'inspect' };
  const action = args[0];
  const flags = new Map<string, string | true>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!flag || flags.has(flag)) throw new Error('Invalid recovery arguments');
    if (flag === '--confirm-deployment-stopped' || flag === '--confirm-executor-stopped')
      flags.set(flag, true);
    else if (['--generation', '--run-id', '--execution-owner'].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing recovery value');
      flags.set(flag, value);
    } else throw new Error('Unknown recovery argument');
  }
  const generation = flags.get('--generation');
  if (typeof generation !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(generation))
    throw new Error('Invalid generation');
  if (
    action === 'release' &&
    flags.size === 2 &&
    flags.get('--confirm-deployment-stopped') === true
  ) {
    return { action, generation };
  }
  const runId = flags.get('--run-id');
  const executionOwner = flags.get('--execution-owner');
  if (
    action === 'reconcile' &&
    flags.size === 4 &&
    flags.get('--confirm-executor-stopped') === true &&
    typeof runId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) &&
    typeof executionOwner === 'string' &&
    executionOwner.length > 0 &&
    executionOwner.length <= 200
  ) {
    return { action, generation, runId, executionOwner };
  }
  throw new Error('Recovery requires exact identifiers and explicit stop confirmation');
}

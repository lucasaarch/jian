import { DeploymentDrain } from './runs/drain.js';
import { DrainRecovery, recoveryOptions } from './runs/drain-recovery.js';
import { PostgresStore } from './storage/postgres.js';

// Operator-only one-shot; no HTTP, model tools, providers, workers or migration startup.
let store: PostgresStore | undefined;
const watchdog = setTimeout(() => {
  console.error('Jian drain recovery deadline exceeded; inspect state before retrying.');
  process.exit(1);
}, 20_000);
watchdog.unref();
try {
  const options = recoveryOptions(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  store = new PostgresStore(process.env.DATABASE_URL, {
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    lock_timeout: 5000,
  });
  const recovery = new DrainRecovery(store);
  if (options.action === 'inspect') console.log(JSON.stringify(await recovery.inspect(), null, 2));
  else if (options.action === 'reconcile') {
    console.log(
      JSON.stringify(
        await recovery.reconcileExecution(
          options.generation,
          options.runId,
          options.executionOwner,
        ),
      ),
    );
  } else {
    const released = await new DeploymentDrain(store).release(options.generation);
    if (!released) throw new Error('Generation not active');
    console.log('Jian deployment generation released.');
  }
} catch {
  // Never print driver errors, arguments or credentials. Inspection is safe to repeat.
  console.error('Jian drain recovery failed; inspect state and verify the expected identifiers.');
  process.exitCode = 1;
} finally {
  await store?.close().catch(() => {
    process.exitCode = 1;
  });
  clearTimeout(watchdog);
}

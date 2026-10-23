import { DeploymentDrain, drainOptions, predeployDrain } from './runs/drain.js';
import { PostgresStore } from './storage/postgres.js';

// Internal one-shot CLI. Do not import main.ts: no HTTP, migrations, queue or provider startup.
let store: PostgresStore | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
  const options = drainOptions(process.argv.slice(2), process.env.CUBESHIP_DEPLOYMENT_ID);
  // Even a broken TCP connection cannot keep the platform hook alive indefinitely.
  watchdog = setTimeout(() => {
    console.error('Jian predeploy drain exceeded its deadline; deployment must not proceed.');
    process.exit(1);
  }, options.timeoutMs + 15_000);
  watchdog.unref();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  store = new PostgresStore(process.env.DATABASE_URL, {
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    lock_timeout: 5000,
  });
  await predeployDrain(new DeploymentDrain(store), options, controller.signal);
  console.log('Jian drained; admission remains closed until explicit generation-matched release.');
} catch {
  // Driver errors, args and connection strings may contain secrets. Never echo them.
  console.error(
    'Jian predeploy drain failed; deployment must not proceed. Inspect the drain before recovery.',
  );
  process.exitCode = 1;
} finally {
  await store?.close().catch(() => {
    process.exitCode = 1;
  });
  if (controller.signal.aborted) process.exitCode = 1;
  clearTimeout(watchdog);
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
}

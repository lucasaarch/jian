import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app, powerSaveBlocker, type UtilityProcess, utilityProcess } from 'electron';
import type { FromWorkers, ToWorkers } from './messages';
import type { WorkerHost, WorkerTarget } from './sharing';
import workerEntry from './worker-process?modulePath';

/** How long a machines process that ended on its own waits before it is started again, growing. */
const RETRY_MS = [1_000, 5_000, 15_000, 60_000];
/** How long quitting waits for the workers' goodbyes before it ends their process, in ms. */
const QUIT_WAIT_MS = 5_000;

/**
 * Where the Computer Use helpers are. Packaged, in the app's resources, where electron-builder
 * puts packages/remote-core/native/bin for this OS; from source, that folder in the checkout,
 * where native/build-*.sh write them. Without them the worker offers the shell alone.
 */
function helpersDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'computer-helpers')
    : join(app.getAppPath(), '..', '..', 'packages', 'remote-core', 'native', 'bin');
}

/**
 * The workers' process, started with the first worker and started again if it ends on its own.
 * While a worker runs the app keeps the computer from suspending it, so agents reach it with
 * the window closed and the screen idle; a closed lid still sleeps the machine.
 */
export class UtilityWorkerHost implements WorkerHost {
  private child?: UtilityProcess;
  private readonly targets = new Map<string, WorkerTarget>();
  private failures = 0;
  private timer?: NodeJS.Timeout;
  private awake?: number;
  private quitting = false;

  constructor(private readonly events: { refused(gatewayId: string): void }) {}

  start(gatewayId: string, target: WorkerTarget): void {
    this.targets.set(gatewayId, target);
    this.post({ type: 'start', gatewayId, target });
    this.keepAwake();
  }

  stop(gatewayId: string): void {
    if (!this.targets.delete(gatewayId)) return;
    this.child?.postMessage({ type: 'stop', gatewayId } satisfies ToWorkers);
    this.keepAwake();
  }

  async stopAll(): Promise<void> {
    this.quitting = true;
    clearTimeout(this.timer);
    this.targets.clear();
    this.keepAwake();
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const forced = setTimeout(() => {
        child.kill();
        resolve();
      }, QUIT_WAIT_MS);
      child.once('exit', () => {
        clearTimeout(forced);
        resolve();
      });
      child.postMessage({ type: 'stopAll' } satisfies ToWorkers);
    });
  }

  private post(message: ToWorkers): void {
    if (this.quitting) return;
    this.process().postMessage(message);
  }

  private process(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(workerEntry, [], {
      serviceName: 'Jian machines',
      // Each worker writes its own log; the process prints only what failed beyond them.
      stdio: ['ignore', 'ignore', 'pipe'],
      env: workerEnv(),
    });
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('message', (message: FromWorkers) => {
      if (message.type === 'refused') {
        this.targets.delete(message.gatewayId);
        this.keepAwake();
        this.events.refused(message.gatewayId);
      }
    });
    child.on('spawn', () => {
      this.failures = 0;
    });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.quitting || this.targets.size === 0) return;
      const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)] ?? 60_000;
      this.failures += 1;
      this.timer = setTimeout(() => this.restart(), wait);
    });
    child.postMessage({
      type: 'setup',
      helpers: helpersDir(),
      helperInstall: join(app.getPath('userData'), 'computer-helper'),
      logs: app.getPath('logs'),
      state: join(app.getPath('userData'), 'machines'),
      version: app.getVersion(),
    } satisfies ToWorkers);
    return child;
  }

  /** A new process takes up every worker the old one ran. */
  private restart(): void {
    for (const [gatewayId, target] of this.targets) this.post({ type: 'start', gatewayId, target });
  }

  private keepAwake(): void {
    const wanted = this.targets.size > 0;
    if (wanted && this.awake === undefined) {
      this.awake = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!wanted && this.awake !== undefined) {
      powerSaveBlocker.stop(this.awake);
      this.awake = undefined;
    }
  }
}

/**
 * The app's environment without Electron's own variables: agents' shell commands inherit it,
 * and an ELECTRON_RUN_AS_NODE left there would change how any Electron app they start behaves.
 */
function workerEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('ELECTRON_')),
  );
}

/**
 * What registering this computer on the gateways came to, in the app's log folder beside each
 * worker's own log: the owner looks there when a machine does not show up.
 */
export function logMachines(message: string): void {
  const dir = app.getPath('logs');
  const line = `${new Date().toISOString()} ${message}\n`;
  void mkdir(dir, { recursive: true })
    .then(() => appendFile(join(dir, 'machines.log'), line, { mode: 0o600 }))
    .catch(() => {});
}

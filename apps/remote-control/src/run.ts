import { existsSync, rmSync } from 'node:fs';
import {
  createWorkerState,
  detectCapabilities,
  runWorker,
  sayGoodbye,
  workerChildEnv,
  workerHeaders,
} from '@jian/remote-core';
import { type Config, loadConfig } from './config.ts';
import { acquireWorkerLock, readWorkerLockPid } from './lock.ts';
import { log } from './log.ts';
import { type Installer, npmInstaller } from './npm.ts';
import { statePath, workerLockPath } from './paths.ts';
import { npmUpdater } from './self-update.ts';
import { PACKAGE_VERSION } from './version.ts';

/**
 * The worker as the OS service runs it: one per machine, held by a lock, telling the gateway
 * when it stops, and updating itself when asked if npm installed it. The polling itself is
 * @jian/remote-core's.
 */
export async function run() {
  await acquireWorkerLock();
  const config = await loadConfig();
  const state = createWorkerState({ path: statePath, version: PACKAGE_VERSION });
  state.update({
    gateway: config.gateway,
    machineId: config.machineId,
    platform: `${process.platform}-${process.arch}`,
  });
  log.info('Worker starting', {
    version: PACKAGE_VERSION,
    pid: process.pid,
    machine: config.machineId,
  });
  const installer = installedWithNpm(config);
  // The gateway sends update tasks only to a worker that says it can carry them out.
  const capabilities = [...(await detectCapabilities()), ...(installer ? ['update-npm'] : [])];
  const mac = await macBehaviour();
  const headers = () =>
    workerHeaders({
      token: config.token,
      version: PACKAGE_VERSION,
      capabilities,
      uiState: mac.uiState,
    });

  const release = () => {
    try {
      mac.stop();
    } catch {
      // ignore
    }
    try {
      if (readWorkerLockPid() === process.pid) rmSync(workerLockPath, { force: true });
    } catch {
      // Best-effort unlock.
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      log.info('Worker stopping', { signal });
      // A stopped worker says so, and `status` stops calling it online.
      state.update({ connected: false, stoppedAt: new Date().toISOString() });
      void sayGoodbye(config, headers()).finally(() => {
        release();
        process.exit(0);
      });
    });
  }
  process.once('exit', release);

  await runWorker({
    config,
    version: PACKAGE_VERSION,
    log,
    state,
    capabilities,
    uiState: mac.uiState,
    ...(installer ? { update: npmUpdater(installer) } : {}),
  });
}

/**
 * How this worker was installed with npm: as `install` recorded it, or — for one installed
 * before it did — as npm on the service's own PATH still shows it.
 */
function installedWithNpm(config: Config): Installer | undefined {
  if (config.installer && existsSync(config.installer.npm)) return config.installer;
  return npmInstaller(workerChildEnv());
}

/**
 * On a Mac, the worker keeps the machine from idling while it runs and tells the gateway whether
 * the screen is locked or asleep. Elsewhere, and if the helper cannot load, neither.
 */
async function macBehaviour() {
  const none = { uiState: () => 'unknown', stop: () => {} };
  if (process.platform !== 'darwin') return none;
  try {
    const mac = await import('@jian/remote-core/computer/macos');
    mac.startWorkerIdleAssertion(process.pid);
    return { uiState: () => mac.probeMacUiState(), stop: () => mac.stopWorkerIdleAssertion() };
  } catch {
    return none;
  }
}

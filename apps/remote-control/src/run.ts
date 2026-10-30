import { rmSync } from 'node:fs';
import {
  createWorkerState,
  detectCapabilities,
  runWorker,
  sayGoodbye,
  workerBase,
  workerHeaders,
} from '@jian/remote-core';
import { loadConfig } from './config.ts';
import { acquireWorkerLock, readWorkerLockPid } from './lock.ts';
import { log } from './log.ts';
import { statePath, workerLockPath } from './paths.ts';
import { reconcileWorkerWithGateway } from './update.ts';
import { PACKAGE_VERSION } from './version.ts';

/**
 * The worker as the OS service runs it: one per machine, held by a lock, on the gateway's
 * release, telling the gateway when it stops. The polling itself is @jian/remote-core's.
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
  const capabilities = await detectCapabilities();
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
    reconcile: (current) => reconcileWorkerWithGateway(config, workerBase(config), current),
  });
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

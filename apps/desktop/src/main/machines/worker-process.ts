/**
 * The machines process: a utility process of the app that runs this computer's worker for each
 * server gateway, from @jian/remote-core. Apart from the main process because the worker blocks
 * while it runs a helper (the Mac's screen-state probe, waking the display), which would freeze
 * the window, and so a worker that fails takes nothing else down with it.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createLogger,
  createWorkerState,
  detectCapabilities,
  executeTask,
  type Logger,
  runWorker,
  sayGoodbye,
  setHelpersInstallDir,
  setHelpersRoot,
  setHostWording,
  type WorkerStateFile,
  workerHeaders,
} from '@jian/remote-core';
import { net } from 'electron';
import type { FromWorkers, ToWorkers, WorkersSetup } from './messages';
import type { WorkerTarget } from './sharing';

/** How long a stopping worker may finish the poll it is in before it says goodbye, in ms. */
const STOP_WAIT_MS = 3_000;

type Worker = {
  target: WorkerTarget;
  controller: AbortController;
  done: Promise<void>;
  log: Logger;
  state: WorkerStateFile;
};

const port = process.parentPort;
const send = (message: FromWorkers) => port.postMessage(message);
const workers = new Map<string, Worker>();
let setup: WorkersSetup | undefined;
let capabilities: Promise<string[]> | undefined;
let uiState: () => string = () => 'unknown';

/**
 * The workers reach their gateways through Chromium's network stack, as the window does, so the
 * system's proxy settings and certificates apply to them too.
 */
globalThis.fetch = net.fetch as typeof fetch;

/** What the owner is told about the worker here: it is the app, and the app is what updates. */
setHostWording({
  name: 'Jian',
  update: () => 'update the Jian app.',
  restart: 'Quit and reopen Jian',
});

async function start(gatewayId: string, target: WorkerTarget): Promise<void> {
  if (!setup) return;
  const current = workers.get(gatewayId);
  if (current && sameTarget(current.target, target)) return;
  if (current) void stop(gatewayId);

  const version = setup.version;
  const log = createLogger({ path: join(setup.logs, `machine-${gatewayId}.log`), echo: false });
  const state = createWorkerState({ path: join(setup.state, `${gatewayId}.json`), version });
  state.update({
    gateway: target.gateway,
    machineId: target.machineId,
    platform: `${process.platform}-${process.arch}`,
  });
  const controller = new AbortController();
  const worker: Worker = { target, controller, log, state, done: Promise.resolve() };
  workers.set(gatewayId, worker);
  log.info('Worker starting', { version, machine: target.machineId });

  capabilities ??= detectCapabilities();
  const offered = await capabilities;
  if (workers.get(gatewayId) !== worker) return;
  worker.done = runWorker({
    config: target,
    version,
    log,
    state,
    capabilities: offered,
    uiState: () => uiState(),
    // The window shows while an agent uses this computer: each task says when it starts and ends.
    execute: async (task) => {
      send({ type: 'using', gatewayId, kind: task.kind === 'computer' ? 'computer' : 'shell' });
      try {
        return await executeTask(task);
      } finally {
        send({ type: 'done', gatewayId });
      }
    },
    // The owner rotated its token or removed the machine: the main process registers again.
    onUnauthorized: () => void stop(gatewayId).then(() => send({ type: 'refused', gatewayId })),
    signal: controller.signal,
  }).catch((error: unknown) => {
    log.error('Worker ended', { error: error instanceof Error ? error.message : String(error) });
  });
}

/** Stops polling, lets the poll under way finish, then tells the gateway it is offline. */
async function stop(gatewayId: string): Promise<void> {
  const worker = workers.get(gatewayId);
  if (!worker) return;
  workers.delete(gatewayId);
  worker.controller.abort();
  await Promise.race([worker.done, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
  worker.state.update({ connected: false, stoppedAt: new Date().toISOString() });
  const headers = workerHeaders({
    token: worker.target.token,
    version: setup?.version ?? '',
    capabilities: (await capabilities?.catch(() => [])) ?? [],
    uiState,
  });
  await sayGoodbye(worker.target, headers);
  worker.log.info('Worker stopped');
}

const sameTarget = (a: WorkerTarget, b: WorkerTarget) =>
  a.gateway === b.gateway && a.machineId === b.machineId && a.token === b.token;

/** On a Mac the gateway hears whether the screen is locked or asleep; elsewhere it is unknown. */
async function watchScreen(): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    const mac = await import('@jian/remote-core/computer/macos');
    uiState = () => mac.probeMacUiState();
  } catch {
    // Without its helper the Mac reports an unknown screen state, as elsewhere.
  }
}

port.on('message', ({ data }: { data: ToWorkers }) => {
  switch (data.type) {
    case 'setup':
      setup = data;
      setHelpersRoot(data.helpers);
      setHelpersInstallDir(data.helperInstall);
      mkdirSync(data.logs, { recursive: true, mode: 0o700 });
      void watchScreen();
      return;
    case 'start':
      void start(data.gatewayId, data.target);
      return;
    case 'stop':
      void stop(data.gatewayId);
      return;
    case 'stopAll':
      void Promise.all([...workers.keys()].map(stop)).then(() => {
        send({ type: 'stopped' });
        process.exit(0);
      });
      return;
  }
});

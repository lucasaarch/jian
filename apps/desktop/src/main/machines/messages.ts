import type { WorkerTarget } from './sharing';

/** What the main process tells the machines process. */
export type ToWorkers =
  /** First, once: where things are. */
  | ({ type: 'setup' } & WorkersSetup)
  | { type: 'start'; gatewayId: string; target: WorkerTarget }
  | { type: 'stop'; gatewayId: string }
  /** The app quits: every worker says goodbye, then the process answers `stopped`. */
  | { type: 'stopAll' };

/** What the machines process tells the main process. */
export type FromWorkers =
  /** The gateway refused the worker's token; the worker has stopped. */
  | { type: 'refused'; gatewayId: string }
  | { type: 'stopped' }
  /** An agent on that gateway began using this computer: a command, or the screen. */
  | { type: 'using'; gatewayId: string; kind: 'shell' | 'computer' }
  /** What it was doing is over. */
  | { type: 'done'; gatewayId: string };

/** Handed to the machines process as it starts. */
export type WorkersSetup = {
  /** Where the Computer Use helpers are: `macos/`, `linux/`, `windows/`. */
  helpers: string;
  /** Where the helper is copied to run from: the app's own, apart from the CLI's. */
  helperInstall: string;
  /** Where each worker writes its log, one file per gateway. */
  logs: string;
  /** Where each worker keeps how it stands. */
  state: string;
  /** The release reported to the gateways: the app's own. */
  version: string;
};

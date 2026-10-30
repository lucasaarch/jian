import { createLogger } from '@jian/remote-core';
import { logPath } from './paths.ts';

/** The worker's log, in its config directory: what `jian-remote logs` reads. */
export const log = createLogger({ path: logPath });

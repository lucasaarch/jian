import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Worker script shipped as `@jian-ai/remote-control`. Resolved from the workspace (dev) or
 * the deployed tree so `/jian-remote.mjs` and `/update` stay available without cloning Jian.
 */
export const workerScriptPath = (() => {
  try {
    return require.resolve('@jian-ai/remote-control/dist/jian-remote.mjs');
  } catch {
    return fileURLToPath(new URL('../../../remote-control/dist/jian-remote.mjs', import.meta.url));
  }
})();

/**
 * Serve the worker with PACKAGE_VERSION stamped to this gateway's release so auto-update and
 * curl fallbacks stay on the same major.minor as the image.
 */
export function workerScriptBytes(): Buffer | undefined {
  if (!existsSync(workerScriptPath)) return undefined;
  let source = readFileSync(workerScriptPath, 'utf8');
  const stamped = process.env.JIAN_VERSION?.replace(/^v/, '');
  if (stamped && VERSION.test(stamped) && stamped !== '0.0.0-dev') {
    source = source.replace(
      /export const PACKAGE_VERSION = '[^']*'/,
      `export const PACKAGE_VERSION = '${stamped}'`,
    );
  }
  return Buffer.from(source, 'utf8');
}

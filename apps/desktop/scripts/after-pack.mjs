import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Puts the local gateway (scripts/stage-gateway.mjs) into the packaged app's resources. It runs
 * here, after packing and before signing, because electron-builder leaves every node_modules out
 * of extraResources, and the gateway's dependencies are what it needs.
 */
export default async function afterPack(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : join(context.appOutDir, 'resources');
  const staged = fileURLToPath(new URL('../.gateway/', import.meta.url));
  await cp(staged, join(resources, 'gateway'), { recursive: true, verbatimSymlinks: true });
}

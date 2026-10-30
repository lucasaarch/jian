import { spawnSync } from 'node:child_process';
import { compatibilityError, fetchGatewayVersion } from '@jian/remote-core';
import { option } from './args.ts';
import { loadConfig } from './config.ts';
import { installRelease, npmInstaller, PACKAGE } from './npm.ts';
import { printInfo } from './output.ts';
import { PACKAGE_VERSION } from './version.ts';

export async function assertCompatibleWithGateway(
  gatewayBase: string,
  localVersion = PACKAGE_VERSION,
): Promise<string | undefined> {
  const gatewayVersion = await fetchGatewayVersion(gatewayBase);
  const error = compatibilityError(localVersion, gatewayVersion);
  if (error) throw new Error(error);
  return gatewayVersion;
}

/**
 * `jian-remote update`: installs the gateway's release (or `--version`) with npm, then hands
 * over to it. The new release's CLI copies itself into ~/.config/jian-remote and restarts the
 * service (`reinstall`); this process is the old release, so it never writes its own bytes
 * there. The credentials stay as they are.
 */
export async function update(): Promise<void> {
  const config = await loadConfig();
  const requested = option('--version')?.trim().replace(/^v/, '');
  const target = requested || (await fetchGatewayVersion(config.gateway)) || 'latest';
  const installer = config.installer ?? npmInstaller();
  if (!installer) {
    throw new Error(
      `Could not find a global npm install of ${PACKAGE}. With Node.js 24+ and npm, run: npm install -g ${PACKAGE}@${target} && jian-remote reinstall`,
    );
  }
  printInfo(`Installing ${PACKAGE}@${target}…`);
  const installed = installRelease(installer, target, { stdio: 'inherit' });
  if (!installed.ok) throw new Error(installed.error);
  const handover = spawnSync(process.execPath, [installed.cli, 'reinstall'], { stdio: 'inherit' });
  if (handover.status !== 0) {
    throw new Error(`${installed.version} is installed, but could not put itself in place.`);
  }
}

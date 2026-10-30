import { readFile } from 'node:fs/promises';
import { parseRelease } from '@jian/remote-core';
import { args, option } from './args.ts';
import {
  loadConfig,
  MACHINE_ID,
  parseGatewayBase,
  readTokenOption,
  writeConfigFile,
} from './config.ts';
import { npmInstaller } from './npm.ts';
import { type Fact, printInfo, printSuccess } from './output.ts';
import { configPath, installedScript } from './paths.ts';
import { startOrRestartService } from './service.ts';
import { assertCompatibleWithGateway } from './update.ts';
import { PACKAGE_VERSION } from './version.ts';
import { materializeWorkerScript } from './worker-script.ts';

export async function install(): Promise<void> {
  const gateway = option('--gateway');
  const machineId = option('--machine');
  // Prefer an explicit --token for one-liner installs from the panel; stdin/prompt keep
  // the token out of shell history when someone installs by hand.
  const token = await readTokenOption();
  const gatewayBase = gateway ? parseGatewayBase(gateway) : undefined;
  if (!gatewayBase || !machineId || !MACHINE_ID.test(machineId) || !token?.trim()) {
    throw new Error(
      'Usage: jian-remote install [--system] --gateway https://... --machine UUID (--token VALUE | --token-prompt | --token-stdin)',
    );
  }
  const gatewayVersion = await assertCompatibleWithGateway(gatewayBase);
  // Run from the user's own shell, where npm is on PATH: the service later may not see it.
  const installer = npmInstaller();
  await writeConfigFile({
    gateway: gatewayBase,
    machineId,
    token: token.trim(),
    ...(installer ? { installer } : {}),
  });
  const script = await materializeWorkerScript();
  const started = await startOrRestartService(script);
  const facts: Fact[] = [
    ['Service', `${started.service} started`],
    ['Config', configPath],
  ];
  if (gatewayVersion) {
    const release = parseRelease(gatewayVersion);
    facts.push(['Gateway', `${gatewayVersion} (major.minor ${release?.major}.${release?.minor})`]);
  }
  if (started.detail) facts.push(['Identity', started.detail]);
  printSuccess('Installed Jian Remote', facts);
  printInfo('See how it stands: jian-remote status');
  printInfo('Read what it did: jian-remote logs');
}

/**
 * Rewrite stored credentials (gateway URL, worker token, and/or machine id) and restart the
 * existing OS service — does not wipe the LaunchAgent / systemd unit / scheduled task.
 */
export async function configure(): Promise<void> {
  const gatewayFlag = option('--gateway');
  const machineFlag = option('--machine');
  const tokenFlag =
    option('--token') !== undefined ||
    args.includes('--token-stdin') ||
    args.includes('--token-prompt');
  if (!gatewayFlag && !machineFlag && !tokenFlag) {
    throw new Error(
      'Usage: jian-remote configure [--gateway https://...] [--machine UUID] (--token VALUE | --token-prompt | --token-stdin)\nChange at least one of gateway, machine, or token. Reads ~/.config/jian-remote; restarts the service.',
    );
  }
  const existing = await loadConfig();

  const gatewayBase = gatewayFlag ? parseGatewayBase(gatewayFlag) : undefined;
  if (gatewayFlag && !gatewayBase) {
    throw new Error('Gateway must be an https:// URL with no credentials, query, or hash.');
  }
  const machineId = machineFlag ?? existing.machineId;
  if (!MACHINE_ID.test(machineId ?? '')) {
    throw new Error('Machine id must be a UUID.');
  }
  const token = tokenFlag ? await readTokenOption() : existing.token;
  if (!token?.trim()) {
    throw new Error('Worker token must not be empty.');
  }

  const config = {
    gateway: gatewayBase ?? existing.gateway,
    machineId,
    token: token.trim(),
    ...(existing.installer ? { installer: existing.installer } : {}),
  };
  if (typeof config.gateway !== 'string' || !config.gateway.startsWith('https://')) {
    throw new Error(`Invalid gateway in ${configPath}; re-run install from the panel.`);
  }

  const gatewayVersion = await assertCompatibleWithGateway(config.gateway);
  await writeConfigFile(config);
  // Prefer the already-installed script so configure does not depend on the npx cache.
  let script = installedScript;
  try {
    await readFile(script);
  } catch {
    script = await materializeWorkerScript();
  }
  const started = await startOrRestartService(script);

  const changed = [
    gatewayFlag ? 'gateway' : null,
    machineFlag ? 'machine' : null,
    tokenFlag ? 'token' : null,
  ].filter(Boolean);
  const facts: Fact[] = [
    ['Changed', changed.join(', ')],
    ['Config', configPath],
    ['Service', `${started.service} restarted`],
  ];
  if (gatewayVersion) {
    const release = parseRelease(gatewayVersion);
    facts.push(['Gateway', `${gatewayVersion} (major.minor ${release?.major}.${release?.minor})`]);
  }
  printSuccess('Configured Jian Remote', facts);
}

/**
 * Puts this release where the service runs it — the worker into ~/.config/jian-remote, its
 * helpers beside it — and restarts the service on it, keeping the credentials. What `update`
 * hands over to once npm installed a release; `--no-restart` leaves the restart to a worker
 * that still has to report how its update went.
 */
export async function reinstall(): Promise<void> {
  const config = await loadConfig();
  const installer = npmInstaller() ?? config.installer;
  await writeConfigFile({ ...config, ...(installer ? { installer } : {}) });
  const script = await materializeWorkerScript();
  const facts: Fact[] = [['Version', PACKAGE_VERSION]];
  if (!args.includes('--no-restart')) {
    const started = await startOrRestartService(script);
    facts.push(['Service', `${started.service} restarted`]);
  }
  printSuccess('Reinstalled Jian Remote', facts);
}

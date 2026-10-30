import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  compatibilityError,
  fetchGatewayVersion,
  isDevVersion,
  nextUpdateBackoffMs,
  parseRelease,
  shouldMatchGatewayVersion,
  versionsCompatible,
} from '@jian/remote-core';
import { option } from './args.ts';
import { type Config, loadConfig } from './config.ts';
import { releaseWorkerLock } from './lock.ts';
import { log } from './log.ts';
import { type Fact, printInfo, printSuccess } from './output.ts';
import { configDir, configPath, installedScript, updateStatePath } from './paths.ts';
import { startOrRestartService } from './service.ts';
import { PACKAGE_VERSION } from './version.ts';
import {
  fetchNpmWorkerScript,
  isStaleInstalledWorker,
  materializeHelpers,
  materializeWorkerScript,
  readEmbeddedVersion,
  validateWorkerScriptBytes,
} from './worker-script.ts';
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
 * Refresh the installed worker from npm (or this process when already the right build), using
 * credentials already stored under ~/.config/jian-remote — never re-ask for token/machine/gateway.
 */
export async function update(): Promise<void> {
  const config = await loadConfig();
  if (typeof config.gateway !== 'string' || !config.gateway.startsWith('https://')) {
    throw new Error(`Invalid gateway in ${configPath}; re-run install from the panel.`);
  }
  const gatewayVersion = await fetchGatewayVersion(config.gateway);
  const requested = option('--version');
  const target = requested?.trim() || gatewayVersion || 'latest';

  let scriptBytes: Buffer | undefined;
  let installedVersion = PACKAGE_VERSION;
  // When this process already matches the target (typical right after npm installed it),
  // copy ourselves. Require an **exact** semver match — same major.minor alone used to let a
  // global 0.8.1 CLI rewrite the installed script while the gateway was already on 0.8.2,
  // fighting auto-update and flip-flopping two pollers.
  const selfMatchesTarget =
    target === 'latest'
      ? !isDevVersion(PACKAGE_VERSION)
      : PACKAGE_VERSION === target.replace(/^v/, '');

  if (selfMatchesTarget && !isDevVersion(PACKAGE_VERSION)) {
    scriptBytes = await readFile(fileURLToPath(import.meta.url));
    installedVersion = PACKAGE_VERSION;
  } else {
    // Prefer the gateway’s stamped script when targeting that release — works when npm has not
    // published the version yet. Fall back to npm pack for pins / latest.
    const wantGatewayScript =
      gatewayVersion &&
      target !== 'latest' &&
      parseRelease(target)?.raw === parseRelease(gatewayVersion)?.raw;
    if (wantGatewayScript) {
      try {
        printInfo('Downloading worker script from the gateway…');
        scriptBytes = await fetchGatewayWorkerScript(config.gateway);
        installedVersion = readEmbeddedVersion(scriptBytes.toString('utf8'));
      } catch (error) {
        printInfo(
          `Gateway script download failed (${error instanceof Error ? error.message : error}); trying npm…`,
        );
      }
    }
    if (!scriptBytes) {
      printInfo(`Downloading @jian-ai/remote-control@${target}…`);
      scriptBytes = fetchNpmWorkerScript(target);
      installedVersion = readEmbeddedVersion(scriptBytes.toString('utf8'));
    }
  }

  const error = compatibilityError(installedVersion, gatewayVersion);
  if (error) throw new Error(error);

  const script = await materializeWorkerScript(scriptBytes);

  // Keep a global install in sync when the operator uses the jian-remote bin from PATH.
  const npmInstall = spawnSync(
    'npm',
    ['install', '-g', `@jian-ai/remote-control@${target === 'latest' ? installedVersion : target}`],
    { stdio: 'inherit', windowsHide: true },
  );
  if (npmInstall.status !== 0) {
    printInfo(
      'Global npm install skipped or failed; the service still uses ~/.config/jian-remote/jian-remote.mjs.',
    );
  }

  const started = await startOrRestartService(script);
  const facts: Fact[] = [
    ['Version', installedVersion],
    ['Service', `${started.service} restarted`],
  ];
  if (gatewayVersion) facts.push(['Gateway', gatewayVersion]);
  if (started.detail) facts.push(['Identity', started.detail]);
  printSuccess('Updated Jian Remote', facts);
}

/** How the automatic update has been failing, kept across restarts to back off. */
type UpdateState = { failures: number; lastError?: string; lastFailureAt?: string };

async function readUpdateState(): Promise<UpdateState> {
  try {
    const raw = JSON.parse(await readFile(updateStatePath, 'utf8'));
    return {
      failures: Number(raw?.failures) || 0,
      lastError: typeof raw?.lastError === 'string' ? raw.lastError : undefined,
      lastFailureAt: typeof raw?.lastFailureAt === 'string' ? raw.lastFailureAt : undefined,
    };
  } catch {
    return { failures: 0 };
  }
}

async function clearUpdateState(): Promise<void> {
  try {
    rmSync(updateStatePath, { force: true });
  } catch {
    // Best-effort; a stale state file only delays the next retry.
  }
}

async function recordUpdateFailure(
  error: unknown,
): Promise<{ failures: number; lastError: string; backoffMs: number }> {
  const previous = await readUpdateState();
  const failures = previous.failures + 1;
  const lastError = error instanceof Error ? error.message : String(error);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    updateStatePath,
    `${JSON.stringify(
      {
        failures,
        lastError,
        lastFailureAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { failures, lastError, backoffMs: nextUpdateBackoffMs(failures) };
}

/**
 * Atomically replace the installed worker script and exit so LaunchAgent / systemd KeepAlive
 * (or a detached Windows child) load the new code. Never touches config.json.
 * Does not call startOrRestartService — that would race KeepAlive and leave two pollers.
 */
async function applyWorkerScriptAndRestart(
  updated: Buffer,
  { sourceLabel }: { sourceLabel: string },
): Promise<false> {
  const checked = validateWorkerScriptBytes(updated);
  if (!checked.ok) throw new Error(checked.message);
  // Same bytes already on disk and already loaded — do not thrash restart loops when npm and
  // the gateway script disagree about packaging but stamp the same version.
  try {
    const existing = await readFile(installedScript);
    if (existing.equals(updated) && checked.version === PACKAGE_VERSION) {
      await clearUpdateState();
      return false;
    }
  } catch {
    // No installed script yet — fall through and write.
  }
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const temp = `${installedScript}.${process.pid}.tmp`;
  await writeFile(temp, updated, { mode: 0o700 });
  await rename(temp, installedScript);
  if (process.platform !== 'win32') await chmod(installedScript, 0o700);
  // The gateway serves the script alone; the helpers beside it stay those of the last npm install.
  await materializeHelpers();
  await clearUpdateState();
  log.info(`Worker updated to ${checked.version} from ${sourceLabel}; restarting to apply it.`);
  await releaseWorkerLock();
  if (process.platform === 'win32') {
    // Task Scheduler has no KeepAlive; spawn the new script then exit this process.
    // Only one detached child — do not also leave this process polling.
    const child = spawn(process.execPath, [installedScript, 'run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
  // macOS LaunchAgent KeepAlive / Linux systemd Restart=always reload this path.
  return process.exit(0);
}

/**
 * Pull the gateway-served worker (same bytes as /jian-remote.mjs, auth’d). Prefer this over npm
 * for fleets that can reach the gateway but not the registry.
 */
async function updateIfNeeded(base: string, headers: Record<string, string>): Promise<void> {
  const script = installedScript;
  let local: Buffer;
  try {
    local = await readFile(script);
  } catch {
    local = await readFile(fileURLToPath(import.meta.url));
  }
  if (isStaleInstalledWorker(PACKAGE_VERSION, local.toString('utf8'))) {
    log.info(
      `Worker process ${PACKAGE_VERSION} is stale (installed script is newer); restarting to load it.`,
    );
    await releaseWorkerLock();
    process.exit(0);
  }
  const etag = `"${createHash('sha256').update(local).digest('hex')}"`;
  const response = await fetch(`${base}/update`, {
    headers: { ...headers, 'if-none-match': etag },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  // Disk matches the gateway; the caller decides whether this process is the wrong release.
  if (response.status === 304) return;
  if (!response.ok) throw new Error(`worker update check failed: HTTP ${response.status}`);
  const updated = Buffer.from(await response.arrayBuffer());
  // A real replace exits the process; returning means the script was already current.
  await applyWorkerScriptAndRestart(updated, { sourceLabel: 'the gateway' });
}

/** Public /jian-remote.mjs — same stamped bytes as authenticated /update, no worker token. */
async function fetchGatewayWorkerScript(gatewayBase: string, fetcher = fetch): Promise<Buffer> {
  const response = await fetcher(`${gatewayBase.replace(/\/$/, '')}/jian-remote.mjs`, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Could not download gateway worker script: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fallback when authenticated /update did not leave disk on the gateway release.
 * Prefer public /jian-remote.mjs (works when npm is not promoted yet); then npm pack.
 */
async function updateFromNpm(
  gatewayVersion: string | undefined,
  gatewayBase: string,
): Promise<void> {
  const target = parseRelease(gatewayVersion)?.raw;
  if (!target)
    throw new Error('Cannot download a worker update without a gateway release version.');
  if (gatewayBase) {
    try {
      console.log(`Downloading worker script from the gateway (/jian-remote.mjs)…`);
      const fromGateway = await fetchGatewayWorkerScript(gatewayBase);
      await applyWorkerScriptAndRestart(fromGateway, {
        sourceLabel: 'the gateway (/jian-remote.mjs)',
      });
    } catch (error) {
      console.error(
        `Gateway script download failed (${error instanceof Error ? error.message : error}); trying npm…`,
      );
    }
  }
  console.log(`Downloading @jian-ai/remote-control@${target} from npm…`);
  const scriptBytes = fetchNpmWorkerScript(target);
  await applyWorkerScriptAndRestart(scriptBytes, { sourceLabel: `npm @${target}` });
}

/**
 * On connect and every few minutes: match the gateway’s worker script. Same major.minor patch
 * bumps use the authenticated /update ETag path; major.minor skew also self-updates to the
 * gateway version (gateway script first, npm fallback) instead of refusing forever.
 *
 * Prefer the gateway script. Only hit npm when the gateway path did not leave the **installed**
 * script on the gateway release — never rewrite a correct gateway install with an older npm
 * tarball (staged-but-unpublished packages caused 0.8.1↔0.8.2 thrash).
 */
export async function reconcileWorkerWithGateway(
  config: Config,
  base: string,
  headers: Record<string, string>,
): Promise<string | undefined> {
  const gatewayVersion = await fetchGatewayVersion(config.gateway);
  const gatewayRelease = parseRelease(gatewayVersion)?.raw;
  const compat = versionsCompatible(PACKAGE_VERSION, gatewayVersion);
  const mustMatch = shouldMatchGatewayVersion(PACKAGE_VERSION, gatewayVersion);

  let installedVersion: string | undefined;
  try {
    installedVersion = readEmbeddedVersion((await readFile(installedScript)).toString('utf8'));
  } catch {
    installedVersion = undefined;
  }

  let gatewayUpdateError: Error | undefined;
  try {
    // Returns only when nothing was applied: a replaced script exits to load itself.
    await updateIfNeeded(base, headers);
    try {
      installedVersion = readEmbeddedVersion((await readFile(installedScript)).toString('utf8'));
    } catch {
      // keep previous
    }
    // 304 and still wrong version → gateway bytes match disk but this process is stale, or the
    // gateway could not stamp a newer script. Fall through to npm only when disk is wrong too.
    if (mustMatch) {
      if (gatewayRelease && installedVersion === gatewayRelease) {
        log.info(
          `Installed worker is ${installedVersion} but this process is ${PACKAGE_VERSION}; restarting to load the installed script.`,
        );
        await releaseWorkerLock();
        process.exit(0);
      }
      gatewayUpdateError = new Error(
        `Gateway worker script is unchanged but this process is ${PACKAGE_VERSION} (gateway ${gatewayVersion}).`,
      );
    }
  } catch (error) {
    gatewayUpdateError = error instanceof Error ? error : new Error(String(error));
  }

  const diskAlreadyMatches = Boolean(gatewayRelease) && installedVersion === gatewayRelease;

  if (gatewayUpdateError && (mustMatch || !compat.ok) && !diskAlreadyMatches) {
    log.warn(
      `Gateway self-update did not apply (${gatewayUpdateError.message}); trying npm for ${gatewayVersion}…`,
    );
    try {
      await updateFromNpm(gatewayVersion, config.gateway);
    } catch (npmError) {
      const recorded = await recordUpdateFailure(npmError);
      log.warn(
        `Automatic worker update failed (${recorded.lastError}). Will retry after ${(recorded.backoffMs / 1000).toFixed(0)}s. Credentials in ${configPath} were not changed.`,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, recorded.backoffMs));
      if (!compat.ok) {
        log.warn(
          compatibilityError(PACKAGE_VERSION, gatewayVersion) ??
            `This remote-control ${PACKAGE_VERSION} cannot connect to gateway ${gatewayVersion}.`,
        );
        process.exit(1);
      }
      // Compatible (same major.minor) but newer patch unavailable — keep running on the old build.
      log.warn('Continuing on the installed worker; will retry the update later.');
      return gatewayVersion;
    }
  } else if (gatewayUpdateError && diskAlreadyMatches) {
    log.warn(
      `Worker update check reported ${gatewayUpdateError.message}; installed script already matches gateway ${gatewayRelease}. Not rewriting from npm.`,
    );
  } else if (gatewayUpdateError) {
    // Optional content refresh failed while still compatible — log and keep polling.
    log.warn(`Worker update check failed: ${gatewayUpdateError.message}`);
  }

  if (!compat.ok) {
    // Update paths returned without exiting (should be rare); refuse with backoff.
    const recorded = await recordUpdateFailure(
      new Error(`Still incompatible with gateway ${gatewayVersion} after update attempts.`),
    );
    log.warn(
      compatibilityError(PACKAGE_VERSION, gatewayVersion) ??
        `This remote-control ${PACKAGE_VERSION} cannot connect to gateway ${gatewayVersion}.`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, recorded.backoffMs));
    process.exit(1);
  }

  return gatewayVersion;
}

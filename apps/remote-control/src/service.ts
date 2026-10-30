import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { args, parseCliInvocation } from './args.ts';
import {
  buildLinuxServiceUnit,
  canInstallLinuxSystemUnit,
  type LinuxServiceScope,
  linuxServiceKind,
  linuxUserUnitPath,
  readLinuxServiceScope,
  resolveLinuxInstallScope,
  writeLinuxServiceScope,
} from './linux-service.ts';
import { readWorkerLockPid, releaseWorkerLock, sleepMs, terminateWorkerPid } from './lock.ts';
import { buildLaunchAgentPlist, materializeMacosAppRuntime } from './macos-app.ts';
import { type Fact, printInfo, printSuccess } from './output.ts';
import {
  configDir,
  installedScript,
  LINUX_SERVICE_UNIT,
  LINUX_SYSTEM_UNIT_PATH,
  MACOS_APP_NAME,
  MACOS_LAUNCH_AGENT_LABEL,
  WINDOWS_TASK_NAME,
  workerLockPath,
} from './paths.ts';
export function runChecked(command: string, commandArgs: string[], message: string): void {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(message);
}

/** Which OS service runs the worker, and what it says about itself. */
type Started = { service: string; detail?: string };

/** The logged-in user's launchd domain, where the LaunchAgent lives. */
function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function macosPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${MACOS_LAUNCH_AGENT_LABEL}.plist`);
}

export function serviceKindForPlatform(
  platform: NodeJS.Platform = process.platform,
  linuxScope: LinuxServiceScope = 'user',
): string {
  if (platform === 'darwin') return 'LaunchAgent';
  if (platform === 'linux') return linuxServiceKind(linuxScope);
  if (platform === 'win32') return 'Task Scheduler';
  return 'none';
}

/**
 * Fully stop the OS service and any worker still holding the pid lock.
 * Clear success/failure for the `jian-remote stop` CLI.
 */
async function stopService(): Promise<{ service: string; stopped: true }> {
  const linuxScope: LinuxServiceScope =
    process.platform === 'linux' ? await readLinuxServiceScope() : 'user';
  const kind = serviceKindForPlatform(process.platform, linuxScope);
  if (process.platform === 'darwin') {
    const plistPath = macosPlistPath();
    const domain = launchdDomain();
    spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    spawnSync('launchctl', ['bootout', `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`], {
      stdio: 'ignore',
    });
  } else if (process.platform === 'linux') {
    if (linuxScope === 'system') {
      spawnSync('systemctl', ['stop', LINUX_SERVICE_UNIT], { stdio: 'ignore' });
    } else {
      spawnSync('systemctl', ['--user', 'stop', LINUX_SERVICE_UNIT], { stdio: 'ignore' });
    }
  } else if (process.platform === 'win32') {
    spawnSync('schtasks.exe', ['/End', '/TN', WINDOWS_TASK_NAME], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    throw new Error(`Service stop is unsupported on ${process.platform}.`);
  }

  const locked = readWorkerLockPid();
  if (locked) {
    const result = terminateWorkerPid(locked);
    if (!result.stopped) {
      throw new Error(
        `Stopped the ${kind} job but worker pid ${locked} is still running. Try again or kill it manually.`,
      );
    }
  }
  await releaseWorkerLock({ pid: locked ?? process.pid });
  // Also clear a lock we never owned (stop from a CLI process).
  try {
    await unlink(workerLockPath);
  } catch {
    // absent
  }
  return { service: kind, stopped: true };
}

/**
 * Register (if needed) and start exactly one worker. Always stops any previous instance first.
 * On macOS, ProgramArguments[0] is the Jian Remote.app Node copy — not system node — so
 * Login Items / TCC show "Jian Remote".
 */
async function startService(script = installedScript): Promise<Started> {
  try {
    await stopService();
  } catch (error) {
    // First install / never registered: stop may complain on exotic platforms only.
    // A live pid that will not die must still fail the start.
    if (error instanceof Error && /still running/i.test(error.message)) throw error;
  }

  try {
    await readFile(script);
  } catch {
    throw new Error(
      `No installed worker at ${script}. Run: jian-remote install --gateway … --machine … --token …`,
    );
  }

  if (process.platform === 'darwin') {
    const launchAgents = join(homedir(), 'Library', 'LaunchAgents');
    const plistPath = macosPlistPath();
    const app = await materializeMacosAppRuntime();
    await mkdir(launchAgents, { recursive: true, mode: 0o700 });
    await writeFile(
      plistPath,
      buildLaunchAgentPlist({
        label: MACOS_LAUNCH_AGENT_LABEL,
        executable: app.executable,
        script,
        logPath: join(configDir, 'worker.log'),
      }),
      { mode: 0o600 },
    );
    const domain = launchdDomain();
    // bootout again after writing the plist so KeepAlive cannot resurrect the old definition.
    spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    sleepMs(400);
    const loaded = spawnSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
    if (loaded.status !== 0) throw new Error('Could not start Jian Remote with launchd');
    return {
      service: 'LaunchAgent',
      detail: `Login Items identity: ${MACOS_APP_NAME}.app (${app.appRoot})`,
    };
  }
  if (process.platform === 'linux') {
    const scope = await resolveLinuxInstallScope();
    const unitBody = buildLinuxServiceUnit({ script, scope });
    if (scope === 'system') {
      // Drop a leftover user unit so stop/start do not fight two managers.
      spawnSync('systemctl', ['--user', 'disable', '--now', LINUX_SERVICE_UNIT], {
        stdio: 'ignore',
      });
      try {
        await unlink(linuxUserUnitPath());
      } catch {
        // absent
      }
      await writeFile(LINUX_SYSTEM_UNIT_PATH, unitBody, { mode: 0o644 });
      await writeLinuxServiceScope('system');
      for (const command of [['daemon-reload'], ['enable', '--now', LINUX_SERVICE_UNIT]]) {
        const result = spawnSync('systemctl', command, { stdio: 'inherit' });
        if (result.status !== 0) {
          throw new Error('Could not install/start Jian Remote with systemd (system unit)');
        }
      }
      if (!args.includes('--system') && parseCliInvocation(args).command === 'install') {
        printInfo(
          'systemd --user bus unavailable; installed a system unit instead (headless/root). Prefer a normal user + loginctl enable-linger when you can.',
        );
      }
      return { service: linuxServiceKind('system'), detail: LINUX_SYSTEM_UNIT_PATH };
    }

    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    await mkdir(unitDir, { recursive: true, mode: 0o700 });
    await writeFile(linuxUserUnitPath(), unitBody, { mode: 0o600 });
    await writeLinuxServiceScope('user');
    // Best-effort: clear a previous system install if this user can.
    if (existsSync(LINUX_SYSTEM_UNIT_PATH) && canInstallLinuxSystemUnit()) {
      spawnSync('systemctl', ['disable', '--now', LINUX_SERVICE_UNIT], { stdio: 'ignore' });
      try {
        await unlink(LINUX_SYSTEM_UNIT_PATH);
        spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
      } catch {
        // leave system unit; user scope marker wins for this CLI
      }
    }
    for (const command of [['daemon-reload'], ['enable', '--now', LINUX_SERVICE_UNIT]]) {
      const result = spawnSync('systemctl', ['--user', ...command], { stdio: 'inherit' });
      if (result.status !== 0) {
        throw new Error(
          [
            'Could not install/start Jian Remote with systemd --user.',
            'If you see "Failed to connect to bus: No medium found", the user bus is missing',
            '(common on headless VPS / root SSH). Retry with: jian-remote install --system …',
            'or enable lingering: sudo loginctl enable-linger "$(whoami)" && export XDG_RUNTIME_DIR=/run/user/$(id -u)',
          ].join(' '),
        );
      }
    }
    return { service: linuxServiceKind('user'), detail: LINUX_SERVICE_UNIT };
  }
  if (process.platform === 'win32') {
    const action = `"${process.execPath}" "${script}" run`;
    runChecked(
      'schtasks.exe',
      [
        '/Create',
        '/SC',
        'ONLOGON',
        '/TN',
        WINDOWS_TASK_NAME,
        '/TR',
        action,
        '/F',
        '/RL',
        'LIMITED',
        '/IT',
      ],
      'Could not install the Jian Remote logon task with Task Scheduler',
    );
    runChecked(
      'schtasks.exe',
      ['/Run', '/TN', WINDOWS_TASK_NAME],
      'Could not start the Jian Remote scheduled task',
    );
    return { service: 'Task Scheduler', detail: `${WINDOWS_TASK_NAME} (ONLOGON)` };
  }
  printInfo(`Service auto-install is unsupported on ${process.platform}. Run: node ${script} run`);
  return { service: 'none', detail: process.platform };
}

async function restartService(script = installedScript): Promise<Started> {
  // stopService is invoked inside startService; call stop first for clear CLI semantics / logs.
  await stopService().catch(() => undefined);
  return startService(script);
}

/** Stops whatever runs and starts `script` under the OS service: install, configure, update. */
export async function startOrRestartService(script: string): Promise<Started> {
  return restartService(script);
}

export async function cliStop() {
  const result = await stopService();
  printSuccess('Stopped Jian Remote', [['Service', `${result.service} stopped`]]);
}

export async function cliStart() {
  const started = await startService(installedScript);
  const facts: Fact[] = [['Service', `${started.service} started`]];
  if (started.detail) facts.push(['Identity', started.detail]);
  printSuccess('Started Jian Remote', facts);
}

export async function cliRestart() {
  const started = await restartService(installedScript);
  const facts: Fact[] = [['Service', `${started.service} restarted`]];
  if (started.detail) facts.push(['Identity', started.detail]);
  printSuccess('Restarted Jian Remote', facts);
}

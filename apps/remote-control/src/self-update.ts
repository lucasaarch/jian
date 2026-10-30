import { spawn } from 'node:child_process';
import type { Updater } from '@jian/remote-core';
import { releaseWorkerLock } from './lock.ts';
import { type Installer, installRelease, type Run, runSync } from './npm.ts';
import { installedScript } from './paths.ts';
import { PACKAGE_VERSION } from './version.ts';

/**
 * Restarts the service on the script the new release put in place: this process exits, and
 * launchd's KeepAlive or systemd's Restart=always start the new one. Task Scheduler restarts
 * nothing, so on Windows the new worker is started here first.
 */
async function restartOnNewRelease(): Promise<void> {
  await releaseWorkerLock();
  if (process.platform === 'win32') {
    spawn(process.execPath, [installedScript, 'run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  }
  process.exit(0);
}

/**
 * The gateway asked this worker to move to a release. npm installs it globally; then the new
 * release's own CLI copies itself and its helpers to where the service runs them
 * (`reinstall --no-restart`), so the old code here never writes its old bytes there. The worker
 * reports how it went, and only then restarts.
 */
export function npmUpdater(
  installer: Installer,
  {
    spawn: run = runSync,
    restart = restartOnNewRelease,
    version = PACKAGE_VERSION,
  }: { spawn?: Run; restart?: () => Promise<void>; version?: string } = {},
): Updater {
  return async (task) => {
    const target = task.update?.version ?? 'latest';
    // Leave the gateway room to hear back before its own deadline for the task.
    const timeoutMs = Math.max(30_000, task.timeoutMs - 30_000);
    const failed = (stderr: string) => ({
      result: { taskId: task.id, exitCode: 1, stdout: '', stderr },
    });

    const installed = installRelease(installer, target, { spawn: run, timeoutMs });
    if (!installed.ok) return failed(installed.error);

    const handover = run(process.execPath, [installed.cli, 'reinstall', '--no-restart'], {
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (handover.status !== 0) {
      const reason = handover.error?.message ?? (handover.stderr ?? '').trim().slice(-2000);
      return failed(
        `${installed.version} is installed, but could not put itself in place. ${reason}`,
      );
    }

    const to = installed.version;
    return {
      result: {
        taskId: task.id,
        exitCode: 0,
        stdout:
          to === version
            ? `Jian Remote is already on ${to}.`
            : `Updated Jian Remote from ${version} to ${to}.`,
        stderr: '',
        update: { from: version, to },
      },
      ...(to === version ? {} : { restart }),
    };
  };
}

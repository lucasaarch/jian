import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { RemoteResult, RemoteTask } from '@jian/contracts';

/** How a child is started: `spawn`, or a test's stand-in. */
type Spawn = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;
/**
 * The PATH a command gets when the worker's own is empty or thin, as under launchd: where the
 * usual tools live, Homebrew's included.
 */
export const MINIMAL_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
/** Soft stdout/stderr caps while capturing a command (chars). Gateway schema matches these. */
export const STDOUT_CAP = 400_000;
export const STDERR_CAP = 50_000;

export function cappedAppend(current: string, chunk: string | Buffer, cap = STDOUT_CAP): string {
  return (current + chunk.toString('utf8')).slice(0, cap);
}

/** Absolute shell path for remote commands — never rely on PATH for the shell itself. */
export function shellCommandForPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'powershell.exe';
  if (existsSync('/bin/sh')) return '/bin/sh';
  if (existsSync('/bin/bash')) return '/bin/bash';
  if (existsSync('/usr/bin/sh')) return '/usr/bin/sh';
  return '/bin/sh';
}

/**
 * Resolve the working directory for a remote shell task.
 * libuv reports a missing cwd as `spawn /bin/sh ENOENT` even when the shell exists — Computer
 * Use kept working (no cwd) while run_remote_command failed. Fall back to $HOME when the
 * requested path is missing or not a directory, and surface an English note in stderr.
 */
export function resolveShellCwd(
  requested: string | null | undefined,
  {
    home = homedir(),
    exists = existsSync,
    stat = statSync,
  }: {
    home?: string;
    exists?: (path: string) => boolean;
    stat?: (path: string) => { isDirectory(): boolean };
  } = {},
): { cwd: string; note: string | undefined; usedFallback: boolean } {
  const fallbackCandidates = [home, process.env.TMPDIR, '/tmp', '/'].filter(
    (path): path is string => Boolean(path),
  );
  const fallback =
    fallbackCandidates.find((path) => {
      try {
        return exists(path) && stat(path).isDirectory();
      } catch {
        return false;
      }
    }) || '/';

  if (requested == null || requested === '') {
    return { cwd: fallback, note: undefined, usedFallback: false };
  }
  const target = String(requested).trim();
  if (!target) {
    return { cwd: fallback, note: undefined, usedFallback: false };
  }
  try {
    if (!exists(target)) {
      return {
        cwd: fallback,
        note: `Requested cwd ${target} does not exist on this computer; using ${fallback}.`,
        usedFallback: true,
      };
    }
    if (!stat(target).isDirectory()) {
      return {
        cwd: fallback,
        note: `Requested cwd ${target} is not a directory; using ${fallback}.`,
        usedFallback: true,
      };
    }
    return { cwd: target, note: undefined, usedFallback: false };
  } catch {
    return {
      cwd: fallback,
      note: `Requested cwd ${target} is not usable; using ${fallback}.`,
      usedFallback: true,
    };
  }
}

/** Env for shell / helper children: always a usable PATH and HOME. */
export function workerChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const current = baseEnv[pathKey] ?? baseEnv.PATH ?? '';
  const prefix = process.platform === 'win32' ? '' : MINIMAL_PATH;
  const merged = prefix ? `${prefix}${current ? `:${current}` : ''}` : current || MINIMAL_PATH;
  const home = baseEnv.HOME || baseEnv.USERPROFILE || homedir();
  return {
    ...baseEnv,
    [pathKey]: merged,
    PATH: merged,
    HOME: home,
    ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
  };
}

/**
 * Explain spawn failures. Node’s `spawn /bin/sh ENOENT` usually means the **cwd** was missing,
 * not that /bin/sh vanished — rewrite so operators and agents can act on it.
 */
export function formatShellSpawnError(
  error: unknown,
  { shell, cwd }: { shell?: string; cwd?: string } = {},
): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ENOENT' || /\bENOENT\b/.test(message)) {
    const shellMissing = shell && !existsSync(shell);
    if (shellMissing) {
      return `Could not find the shell executable ${shell}. Install a POSIX shell or reinstall Jian Remote.`;
    }
    return `Could not start the remote shell (${shell || '/bin/sh'}) with cwd ${cwd || '(unknown)'}: the working directory is missing or not usable (Node reports this as spawn ENOENT even when the shell exists).`;
  }
  return message;
}

/**
 * Run a remote shell task. Exported for behavior tests (cwd fallback, absolute shell, PATH).
 */
export function executeShellTask(
  task: RemoteTask,
  {
    spawnImpl = spawn as Spawn,
    platform = process.platform,
  }: { spawnImpl?: Spawn; platform?: NodeJS.Platform } = {},
): Promise<RemoteResult> {
  return new Promise((resolveResult) => {
    const command = task.command ?? '';
    const shell = shellCommandForPlatform(platform);
    const resolved = resolveShellCwd(task.cwd);
    const commandArgs =
      platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
        : ['-lc', command];
    const child = spawnImpl(shell, commandArgs, {
      cwd: resolved.cwd,
      env: workerChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = resolved.note ? `${resolved.note}\n` : '';
    let stdoutSeen = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (platform === 'win32' && child.pid) {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          child.kill('SIGKILL');
        }
      }, 2000).unref();
    }, task.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutSeen += chunk.toString('utf8').length;
      stdout = cappedAppend(stdout, chunk, STDOUT_CAP);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = cappedAppend(stderr, chunk, STDERR_CAP);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolveResult({
        taskId: task.id,
        exitCode: null,
        stdout,
        stderr: cappedAppend(
          stderr,
          formatShellSpawnError(error, { shell, cwd: resolved.cwd }),
          STDERR_CAP,
        ),
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (stdoutSeen > STDOUT_CAP) {
        stderr = cappedAppend(
          stderr,
          '\n[jian-remote] stdout truncated at the worker channel cap\n',
          STDERR_CAP,
        );
      }
      resolveResult({ taskId: task.id, exitCode: code, stdout, stderr, timedOut });
    });
  });
}

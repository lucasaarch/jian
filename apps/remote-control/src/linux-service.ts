import { spawnSync } from 'node:child_process';
import { accessSync, existsSync, constants as fsConstants, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { args, parseCliInvocation } from './args.ts';
import {
  configDir,
  LINUX_SERVICE_UNIT,
  LINUX_SYSTEM_UNIT_PATH,
  linuxServiceScopePath,
} from './paths.ts';

/** Whether the unit belongs to the user's systemd or the machine's. */
export type LinuxServiceScope = 'user' | 'system';

export function linuxUserUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', LINUX_SERVICE_UNIT);
}

/**
 * True when this process can talk to the per-user systemd bus.
 * Headless VPS / root SSH sessions often lack XDG_RUNTIME_DIR and fail with
 * "Failed to connect to bus: No medium found".
 */
export function linuxUserBusAvailable({
  env = process.env,
  run = (argv: string[]) => spawnSync('systemctl', ['--user', ...argv], { encoding: 'utf8' }),
}: {
  env?: NodeJS.ProcessEnv;
  run?: (argv: string[]) => { status: number | null; stderr?: string; error?: Error };
} = {}): boolean {
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (!runtimeDir || typeof runtimeDir !== 'string') return false;
  try {
    if (!statSync(runtimeDir).isDirectory()) return false;
  } catch {
    return false;
  }
  const result = run(['show-environment']);
  if (result.error) return false;
  const stderr = `${result.stderr ?? ''}`;
  if (/Failed to connect to bus|No medium found|No such file or directory/i.test(stderr)) {
    return false;
  }
  return result.status === 0;
}

/** True when this process can install `/etc/systemd/system/jian-remote.service`. */
export function canInstallLinuxSystemUnit({
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  systemDir = '/etc/systemd/system',
  access = (path: string, mode: number) => accessSync(path, mode),
}: {
  uid?: number;
  systemDir?: string;
  access?: (path: string, mode: number) => void;
} = {}): boolean {
  if (uid === 0) return true;
  try {
    access(systemDir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function linuxServiceKind(scope: LinuxServiceScope = 'user'): string {
  return scope === 'system' ? 'systemd (system)' : 'systemd --user';
}

/**
 * Pick systemd --user vs system unit. Prefer --user when the bus works; fall back to a
 * system unit on headless/root hosts; `--system` forces the system unit.
 */
export function chooseLinuxServiceScope({
  preferSystem = false,
  env = process.env,
  userBusAvailable = () => linuxUserBusAvailable({ env }),
  canSystem = () => canInstallLinuxSystemUnit(),
}: {
  preferSystem?: boolean;
  env?: NodeJS.ProcessEnv;
  userBusAvailable?: () => boolean;
  canSystem?: () => boolean;
} = {}): LinuxServiceScope {
  if (preferSystem) {
    if (!canSystem()) {
      throw new Error(
        'install --system needs write access to /etc/systemd/system (run as root, or use sudo).',
      );
    }
    return 'system';
  }
  if (userBusAvailable()) return 'user';
  if (canSystem()) return 'system';
  throw new Error(
    [
      'Could not reach systemd --user (no user bus). This is common on a headless VPS or root SSH session',
      '("Failed to connect to bus: No medium found" / missing XDG_RUNTIME_DIR).',
      '',
      'Fix options:',
      '  1. Prefer a normal user + lingering, then reinstall:',
      '       sudo loginctl enable-linger USERNAME',
      '       # as USERNAME:',
      '       export XDG_RUNTIME_DIR=/run/user/$(id -u)',
      '       jian-remote install --gateway … --machine … --token …',
      '  2. Install a system unit (as root):',
      '       jian-remote install --system --gateway … --machine … --token …',
      '  3. Foreground smoke test (config may already be on disk from a failed install):',
      '       node ~/.config/jian-remote/jian-remote.mjs run',
    ].join('\n'),
  );
}

export async function writeLinuxServiceScope(scope: LinuxServiceScope): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(linuxServiceScopePath, `${scope}\n`, { mode: 0o600 });
}

export async function readLinuxServiceScope(): Promise<LinuxServiceScope> {
  try {
    const text = (await readFile(linuxServiceScopePath, 'utf8')).trim();
    if (text === 'system' || text === 'user') return text;
  } catch {
    // absent or unreadable — fall through to heuristics
  }
  if (existsSync(LINUX_SYSTEM_UNIT_PATH)) return 'system';
  return 'user';
}

/**
 * Fresh `install` probes the bus (and honors `--system`). Later start/restart/update/configure
 * keep the saved scope so a system-unit VPS install does not flip back if a user bus appears.
 */
export async function resolveLinuxInstallScope(): Promise<LinuxServiceScope> {
  const preferSystem = args.includes('--system');
  if (preferSystem) return chooseLinuxServiceScope({ preferSystem: true });
  const command = parseCliInvocation(args).command;
  if (command && command !== 'install') {
    try {
      const saved = (await readFile(linuxServiceScopePath, 'utf8')).trim();
      if (saved === 'system') {
        if (canInstallLinuxSystemUnit()) return 'system';
      } else if (saved === 'user' && linuxUserBusAvailable()) {
        return 'user';
      }
    } catch {
      // choose below
    }
  }
  return chooseLinuxServiceScope({ preferSystem: false });
}

export function buildLinuxServiceUnit({
  script,
  scope,
  home = homedir(),
  nodePath = process.execPath,
  uid = typeof process.getuid === 'function' ? process.getuid() : 0,
  username,
}: {
  script: string;
  scope: LinuxServiceScope;
  home?: string;
  nodePath?: string;
  uid?: number;
  username?: string;
}): string {
  const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const wantedBy = scope === 'system' ? 'multi-user.target' : 'default.target';
  const lines = [
    '[Unit]',
    'Description=Jian Remote worker',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${quote(nodePath)} ${quote(script)} run`,
    'Restart=always',
    'RestartSec=3',
    // System units do not inherit the installing shell's HOME; pin it so config stays findable.
    `Environment=${quote(`HOME=${home}`)}`,
    `WorkingDirectory=${quote(home)}`,
  ];
  if (scope === 'system' && uid !== 0) {
    let name: string | undefined = username;
    if (!name) {
      try {
        name = userInfo().username;
      } catch {
        name = undefined;
      }
    }
    if (name) lines.push(`User=${name}`);
  }
  lines.push('', '[Install]', `WantedBy=${wantedBy}`, '');
  return lines.join('\n');
}

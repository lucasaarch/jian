import { homedir } from 'node:os';
import { join } from 'node:path';
export const configDir = join(homedir(), '.config', 'jian-remote');
export const configPath = join(configDir, 'config.json');
/** Stable path the OS service runs — not the npm global prefix, which an upgrade replaces. */
export const installedScript = join(configDir, 'jian-remote.mjs');
/** Exclusive run lock — prevents KeepAlive / CLI races from leaving two pollers alive. */
export const workerLockPath = join(configDir, 'worker.pid');
/** The worker's own log: what it did and when, the same on every OS whatever its service keeps. */
export const logPath = join(configDir, 'worker.log');
/** Where the running worker says how it stands, for `status`; rewritten as that changes. */
export const statePath = join(configDir, 'state.json');
export const MACOS_LAUNCH_AGENT_LABEL = 'com.jian.remote';
export const LINUX_SERVICE_UNIT = 'jian-remote.service';
/** Remembers whether Linux install used systemd --user or a system unit (headless/root VPS). */
export const linuxServiceScopePath = join(configDir, 'linux-service-scope');
export const LINUX_SYSTEM_UNIT_PATH = join('/etc/systemd/system', LINUX_SERVICE_UNIT);
export const WINDOWS_TASK_NAME = 'Jian Remote';
/** KeepAlive floor so a bad update cannot spin-restart every second. */
export const LAUNCH_AGENT_THROTTLE_INTERVAL_SEC = 10;
export const MACOS_BUNDLE_ID = 'com.jian.remote';
export const MACOS_APP_NAME = 'Jian Remote';

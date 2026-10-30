import { readFile } from 'node:fs/promises';
import type { WorkerState } from '@jian/remote-core';
import { args } from './args.ts';
import type { Config } from './config.ts';
import { isPidAlive, readWorkerLockPid } from './lock.ts';
import { ANSI, type Fact, formatSuccessBlock, paint, printInfo, shouldColorize } from './output.ts';
import { configPath, installedScript, logPath, statePath } from './paths.ts';
import { PACKAGE_VERSION } from './version.ts';
import { readEmbeddedVersion } from './worker-script.ts';
/** A span of time as people say it: 42s, 3m 12s, 5h 2m, 2d 4h. */
export function since(fromIso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The gateway's health, timed: how long a round trip takes from here, and its release. */
type Ping =
  | { ok: boolean; ms: number; status: number; version?: string; error?: undefined }
  | { ok: false; error: string; ms?: undefined; status?: undefined; version?: undefined };

async function pingGateway(gateway: string): Promise<Ping> {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${gateway}/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    const ms = Math.round(performance.now() - startedAt);
    const body = (response.ok ? await response.json().catch(() => ({})) : {}) as {
      version?: unknown;
    };
    const version = typeof body?.version === 'string' ? body.version : undefined;
    return { ok: response.ok, ms, status: response.status, version };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Everything about this worker in one place: where it connects, whether it is running and
 * connected, its versions and the gateway's, what it has run, and how far the gateway is now.
 * `--json` prints the same as one object, for scripts.
 */
export async function status(): Promise<void> {
  let config: Config | undefined;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    config = undefined;
  }
  // Written by whichever worker version ran last, so any field may be missing.
  let state: Partial<WorkerState> | undefined;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    state = undefined;
  }
  let installedVersion: string | undefined;
  try {
    installedVersion = readEmbeddedVersion((await readFile(installedScript)).toString('utf8'));
  } catch {
    installedVersion = undefined;
  }
  const pid = readWorkerLockPid();
  const running = pid !== undefined && isPidAlive(pid);
  const ping = config?.gateway ? await pingGateway(config.gateway) : undefined;
  const connected = running && state?.pid === pid && state?.connected === true;
  const report = {
    installed: Boolean(config),
    running,
    connected,
    ...(running ? { pid } : {}),
    machineId: config?.machineId,
    gateway: config?.gateway,
    cli: PACKAGE_VERSION,
    worker: installedVersion,
    gatewayVersion: ping?.version ?? state?.gatewayVersion,
    ping,
    platform: `${process.platform}-${process.arch}`,
    capabilities: state?.capabilities ?? [],
    startedAt: running ? state?.startedAt : undefined,
    lastContactAt: state?.lastContactAt,
    lastError: state?.lastError ? { message: state.lastError, at: state.lastErrorAt } : undefined,
    tasks: state?.tasks ?? { total: 0, failed: 0, shell: 0, computer: 0 },
    lastTask: state?.lastTask,
    log: logPath,
  };

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (!config) {
    printInfo(
      'Jian Remote is not installed here. Run the command the panel shows for this machine.',
    );
    process.exitCode = 1;
    return;
  }
  const color = shouldColorize();
  const state_ = connected
    ? paint('Connected', ANSI.green, color)
    : running
      ? paint('Running, not connected', ANSI.yellow, color)
      : paint('Stopped', ANSI.red, color);
  const tasks = report.tasks;
  const facts: Fact[] = [
    ['Status', state_],
    ['Machine', config.machineId],
    ['Gateway', config.gateway],
    [
      'Versions',
      `worker ${installedVersion ?? 'not installed'} · cli ${PACKAGE_VERSION} · gateway ${report.gatewayVersion ?? 'unknown'}`,
    ],
    [
      'Ping',
      ping?.ok
        ? `${ping.ms} ms`
        : `unreachable${ping?.status ? ` (HTTP ${ping.status})` : ping?.error ? ` (${ping.error})` : ''}`,
    ],
    [
      'Platform',
      `${report.platform}${report.capabilities.length ? ` · ${report.capabilities.join(', ')}` : ''}`,
    ],
  ];
  if (running)
    facts.push([
      'Process',
      `pid ${pid}${report.startedAt ? `, up ${since(report.startedAt)}` : ''}`,
    ]);
  if (report.lastContactAt) facts.push(['Last contact', `${since(report.lastContactAt)} ago`]);
  facts.push([
    'Actions',
    `${tasks.total} run (${tasks.shell ?? 0} shell, ${tasks.computer ?? 0} computer), ${tasks.failed} failed`,
  ]);
  if (report.lastTask) {
    facts.push([
      'Last action',
      `${report.lastTask.kind}, ${report.lastTask.ok ? 'ok' : 'failed'}, ${report.lastTask.durationMs} ms, ${since(report.lastTask.at)} ago`,
    ]);
  }
  if (report.lastError) {
    const at = report.lastError.at;
    facts.push(['Last error', `${report.lastError.message}${at ? ` (${since(at)} ago)` : ''}`]);
  }
  facts.push(['Log', logPath]);
  const mark = connected
    ? paint('✓', ANSI.green, color)
    : paint(running ? '!' : '✗', running ? ANSI.yellow : ANSI.red, color);
  process.stdout.write(formatSuccessBlock({ headline: 'Jian Remote', facts, color, mark }));
  if (!connected) process.exitCode = 1;
}

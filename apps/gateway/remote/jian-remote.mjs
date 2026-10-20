#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const configPath = join(homedir(), '.config', 'jian-remote', 'config.json');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

async function readStdin() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk.toString('utf8');
  return value;
}

async function install() {
  const gateway = option('--gateway');
  const machineId = option('--machine');
  const token = args.includes('--token-stdin') ? await readStdin() : undefined;
  let gatewayUrl;
  try {
    gatewayUrl = new URL(gateway);
  } catch {}
  if (
    gatewayUrl?.protocol !== 'https:' ||
    gatewayUrl.username ||
    gatewayUrl.password ||
    gatewayUrl.search ||
    gatewayUrl.hash ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      machineId ?? '',
    ) ||
    !token?.trim()
  ) {
    throw new Error(
      'Usage: jian-remote.mjs install --gateway https://... --machine UUID --token-stdin',
    );
  }
  const config = {
    gateway: gatewayUrl.origin + gatewayUrl.pathname.replace(/\/$/, ''),
    machineId,
    token: token.trim(),
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(configPath), 0o700);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  const script = fileURLToPath(import.meta.url);
  if (process.platform === 'darwin') {
    const launchAgents = join(homedir(), 'Library', 'LaunchAgents');
    const plistPath = join(launchAgents, 'com.jian.remote.plist');
    const xml = (value) =>
      value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const label = 'com.jian.remote';
    await mkdir(launchAgents, { recursive: true, mode: 0o700 });
    await writeFile(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string><string>run</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(dirname(configPath), 'worker.log'))}</string><key>StandardErrorPath</key><string>${xml(join(dirname(configPath), 'worker.log'))}</string></dict></plist>\n`,
      { mode: 0o600 },
    );
    const domain = `gui/${process.getuid()}`;
    spawnSync('launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' });
    const loaded = spawnSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
    if (loaded.status !== 0) throw new Error('Could not start Jian Remote with launchd');
    console.log('Installed and started the per-user launchd service.');
  } else if (process.platform === 'linux') {
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    await mkdir(unitDir, { recursive: true, mode: 0o700 });
    const quote = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    const unit = `[Unit]\nDescription=Jian Remote worker\nAfter=network-online.target\n\n[Service]\nExecStart=${quote(process.execPath)} ${quote(script)} run\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
    await writeFile(join(unitDir, 'jian-remote.service'), unit, { mode: 0o600 });
    for (const command of [['daemon-reload'], ['enable', '--now', 'jian-remote.service']]) {
      const result = spawnSync('systemctl', ['--user', ...command], { stdio: 'inherit' });
      if (result.status !== 0)
        throw new Error('Could not install/start Jian Remote with systemd --user');
    }
    console.log('Installed and started the per-user systemd service.');
  } else {
    console.log(
      `Saved credentials to ${configPath}; service auto-install is unsupported on ${process.platform}. Run: node ${script} run`,
    );
  }
  console.log(`Credentials are stored with owner-only permissions in ${configPath}.`);
}

function cappedAppend(current, chunk, cap = 50_000) {
  return (current + chunk.toString('utf8')).slice(0, cap);
}

async function execute(task) {
  return await new Promise((resolveResult) => {
    const child = spawn('/bin/sh', ['-lc', task.command], {
      cwd: task.cwd || homedir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, task.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = cappedAppend(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = cappedAppend(stderr, chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      resolveResult({
        taskId: task.id,
        exitCode: null,
        stdout,
        stderr: cappedAppend(stderr, error.message),
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolveResult({ taskId: task.id, exitCode: code, stdout, stderr, timedOut });
    });
  });
}

async function run() {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const headers = {
    authorization: `Bearer ${config.token}`,
    'x-jian-platform': `${process.platform}-${process.arch}`,
  };
  const base = `${config.gateway}/v1/remote/worker/${config.machineId}`;
  console.log(`Connected to Jian Remote at ${config.gateway}`);
  while (true) {
    try {
      const response = await fetch(`${base}/tasks/next`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`poll failed: HTTP ${response.status}`);
      const { task } = await response.json();
      if (!task) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
        continue;
      }
      const result = await execute(task);
      // Retry the result rather than rerunning the command after a transient network error.
      while (true) {
        try {
          const saved = await fetch(`${base}/tasks/${task.id}/result`, {
            method: 'POST',
            redirect: 'error',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(result),
            signal: AbortSignal.timeout(15_000),
          });
          if (!saved.ok) throw new Error(`result post failed: HTTP ${saved.status}`);
          break;
        } catch (error) {
          console.error(error.message);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
        }
      }
    } catch (error) {
      console.error(error.message);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000));
    }
  }
}

try {
  if (args[0] === 'install') await install();
  else if (args[0] === 'run') await run();
  else
    console.log(
      'Jian Remote worker\n  install --gateway HTTPS_URL --machine UUID --token-stdin\n  run',
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

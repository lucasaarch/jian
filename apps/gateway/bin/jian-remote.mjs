#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

async function readSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Secret prompt requires an interactive terminal; use --token-stdin instead');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return await new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\\u0003') return finish(new Error('Installation cancelled'));
        if (char === '\\r' || char === '\\n') return finish();
        if (char === '\\u007f' || char === '\\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

function runChecked(command, commandArgs, message) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(message);
}

async function install() {
  const gateway = option('--gateway');
  const machineId = option('--machine');
  // Prefer an explicit --token for one-liner installs from the panel; stdin/prompt keep
  // the token out of shell history when someone installs by hand.
  const inlineToken = option('--token');
  const token = inlineToken
    ? inlineToken
    : args.includes('--token-stdin')
      ? await readStdin()
      : args.includes('--token-prompt')
        ? await readSecret('Worker token (input hidden): ')
        : undefined;
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
      'Usage: jian-remote.mjs install --gateway https://... --machine UUID (--token VALUE | --token-prompt | --token-stdin)',
    );
  }
  const config = {
    gateway: gatewayUrl.origin + gatewayUrl.pathname.replace(/\/$/, ''),
    machineId,
    token: token.trim(),
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const account = process.env.USERNAME;
    if (!account) throw new Error('Could not identify the current Windows user');
    runChecked(
      'icacls.exe',
      [dirname(configPath), '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`],
      'Could not restrict permissions on the Jian Remote config directory',
    );
  } else {
    await chmod(dirname(configPath), 0o700);
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform === 'win32') {
    runChecked(
      'icacls.exe',
      [configPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`],
      'Could not restrict permissions on the Jian Remote config file',
    );
  } else {
    await chmod(configPath, 0o600);
  }
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
  } else if (process.platform === 'win32') {
    const action = `"${process.execPath}" "${script}" run`;
    runChecked(
      'schtasks.exe',
      [
        '/Create',
        '/SC',
        'ONLOGON',
        '/TN',
        'Jian Remote',
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
      ['/Run', '/TN', 'Jian Remote'],
      'Could not start the Jian Remote scheduled task',
    );
    console.log('Installed and started the per-user Windows logon task.');
  } else {
    console.log(
      `Saved credentials to ${configPath}; service auto-install is unsupported on ${process.platform}. Run: node ${script} run`,
    );
  }
  console.log(`Credentials are stored with owner-only permissions in ${configPath}.`);
}

function cappedAppend(current, chunk, cap = 400_000) {
  return (current + chunk.toString('utf8')).slice(0, cap);
}

async function execute(task) {
  return await new Promise((resolveResult) => {
    const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const commandArgs =
      process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', task.command]
        : ['-lc', task.command];
    const child = spawn(command, commandArgs, {
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
      setTimeout(() => {
        if (process.platform === 'win32' && child.pid) {
          spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          child.kill('SIGKILL');
        }
      }, 2000).unref();
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

async function updateIfNeeded(base, headers) {
  const script = fileURLToPath(import.meta.url);
  const local = await readFile(script);
  const etag = `"${createHash('sha256').update(local).digest('hex')}"`;
  const response = await fetch(`${base}/update`, {
    headers: { ...headers, 'if-none-match': etag },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 304) return false;
  if (!response.ok) throw new Error(`worker update check failed: HTTP ${response.status}`);
  const updated = Buffer.from(await response.arrayBuffer());
  if (!updated.length || updated.length > 1_000_000) throw new Error('Invalid worker update size');
  const temp = `${script}.${process.pid}.tmp`;
  await writeFile(temp, updated, { mode: 0o700 });
  await rename(temp, script);
  console.log('Worker updated; restarting to apply it.');
  if (process.platform === 'win32') {
    const child = spawn(process.execPath, [script, 'run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
  process.exit(0);
}

async function run() {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const headers = {
    authorization: `Bearer ${config.token}`,
    'x-jian-platform': `${process.platform}-${process.arch}`,
  };
  const base = `${config.gateway}/v1/remote/worker/${config.machineId}`;
  console.log(`Connected to Jian Remote at ${config.gateway}`);
  let failures = 0;
  let nextUpdateCheck = 0;
  const delay = async (attempt) => {
    const ceiling = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.random() * ceiling));
  };
  while (true) {
    try {
      if (Date.now() >= nextUpdateCheck) {
        await updateIfNeeded(base, headers);
        nextUpdateCheck = Date.now() + 5 * 60_000;
      }
      const response = await fetch(`${base}/tasks/next`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`poll failed: HTTP ${response.status}`);
      failures = 0;
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
          await delay(++failures);
        }
      }
    } catch (error) {
      console.error(error.message);
      await delay(++failures);
    }
  }
}

try {
  if (args[0] === 'install') await install();
  else if (args[0] === 'run') await run();
  else
    console.log(
      'Jian Remote worker\n  install --gateway HTTPS_URL --machine UUID (--token VALUE | --token-prompt | --token-stdin)\n  run',
    );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

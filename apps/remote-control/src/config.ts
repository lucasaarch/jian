import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { WorkerConfig } from '@jian/remote-core';
import { args, option } from './args.ts';
import { configDir, configPath } from './paths.ts';
import { runChecked } from './service.ts';

/** What `install` writes to the config file and every other command reads back. */
export type Config = WorkerConfig;

async function readStdin(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) value += chunk.toString('utf8');
  return value;
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Secret prompt requires an interactive terminal; use --token-stdin instead');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') return finish(new Error('Installation cancelled'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    throw new Error(
      `No Jian Remote config at ${configPath}. Run install first (from the panel), or: jian-remote install --gateway https://… --machine UUID --token …`,
    );
  }
}

export const MACHINE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseGatewayBase(gateway: string): string | undefined {
  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(gateway);
  } catch {
    return undefined;
  }
  if (
    gatewayUrl.protocol !== 'https:' ||
    gatewayUrl.username ||
    gatewayUrl.password ||
    gatewayUrl.search ||
    gatewayUrl.hash
  ) {
    return undefined;
  }
  return gatewayUrl.origin + gatewayUrl.pathname.replace(/\/$/, '');
}

export async function readTokenOption(): Promise<string | undefined> {
  const inlineToken = option('--token');
  if (inlineToken) return inlineToken;
  if (args.includes('--token-stdin')) return await readStdin();
  if (args.includes('--token-prompt')) return await readSecret('Worker token (input hidden): ');
  return undefined;
}

/** Persist credentials with owner-only permissions under ~/.config/jian-remote. */
export async function writeConfigFile(config: Config): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const account = process.env.USERNAME;
    if (!account) throw new Error('Could not identify the current Windows user');
    runChecked(
      'icacls.exe',
      [configDir, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`],
      'Could not restrict permissions on the Jian Remote config directory',
    );
  } else {
    await chmod(configDir, 0o700);
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
}

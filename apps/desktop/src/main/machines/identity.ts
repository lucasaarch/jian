import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { detectSystem } from '@jian/remote-core';

/** What a gateway is told about this computer when the app makes it a machine there. */
export type ComputerIdentity = {
  /** As the owner knows it: the name the system settings show. */
  name: string;
  /** As Node names it, `darwin-arm64`, which is also what the worker reports on each poll. */
  platform: string;
  /** The OS by name and version, as a person reads it: `macOS 27.2`, `Windows 11 (26100)`. */
  system: string;
};

/** The gateway keeps a machine's name to 80 characters. */
const NAME_MAX = 80;

/**
 * The computer's name as its owner set it. A Mac's ComputerName is the one System Settings shows
 * (`Ada’s MacBook Pro`), not the network host name derived from it; Windows keeps its own in
 * COMPUTERNAME. Elsewhere the host name, without the `.local` mDNS suffix a Mac or Linux adds.
 */
export function computerName(input: {
  platform: NodeJS.Platform;
  hostname: string;
  env: NodeJS.ProcessEnv;
  /** `scutil --get ComputerName`, on a Mac, when it answered. */
  macName?: string | undefined;
}): string {
  const own =
    input.platform === 'darwin'
      ? input.macName
      : input.platform === 'win32'
        ? input.env.COMPUTERNAME
        : undefined;
  const name = own?.trim() || input.hostname.trim().replace(/\.local\.?$/i, '');
  return (name || 'This computer').slice(0, NAME_MAX);
}

const run = promisify(execFile);

/** The Mac's ComputerName, or undefined when scutil is missing, failed or took too long. */
async function macName(): Promise<string | undefined> {
  try {
    const { stdout } = await run('/usr/sbin/scutil', ['--get', 'ComputerName'], {
      timeout: 3_000,
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** This computer, asked each time: the owner may rename it or update the OS while the app runs. */
export async function thisComputer(): Promise<ComputerIdentity> {
  const { platform } = process;
  const [mac, system] = await Promise.all([
    platform === 'darwin' ? macName() : undefined,
    detectSystem(platform),
  ]);
  return {
    name: computerName({ platform, hostname: hostname(), env: process.env, macName: mac }),
    platform: `${platform}-${process.arch}`,
    system,
  };
}

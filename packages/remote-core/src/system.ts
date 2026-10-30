import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { release } from 'node:os';

/**
 * The longest description sent, in characters; the gateway keeps no more. Headers carry only
 * printable ASCII safely, so anything else is dropped before it is sent.
 */
const SYSTEM_MAX_LENGTH = 100;

function printable(value: string): string {
  return value
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SYSTEM_MAX_LENGTH)
    .trim();
}

/** `sw_vers -productVersion` (`27.2`, `15.4.1`) as `macOS 27.2`; null when it said nothing. */
export function macosSystem(productVersion: string): string | null {
  const version = productVersion.trim();
  return /^\d+(\.\d+)*$/.test(version) ? `macOS ${version}` : null;
}

/**
 * Windows from its kernel release (`os.release()`, `10.0.26100`). Windows 11 still reports
 * 10.0 and differs only in its build, from 22000 on; the build is what tells releases apart.
 */
export function windowsSystem(kernelRelease: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(kernelRelease.trim());
  if (!match) return printable(`Windows ${kernelRelease}`) || 'Windows';
  const [, major, , build] = match;
  if (major === '10') return `Windows ${Number(build) >= 22000 ? '11' : '10'} (${build})`;
  return `Windows ${kernelRelease.trim()}`;
}

/** `/etc/os-release` values may be quoted and backslash-escaped (os-release(5)). */
function osReleaseValue(text: string, key: string): string | undefined {
  const line = text.split('\n').find((entry) => entry.trimStart().startsWith(`${key}=`));
  if (!line) return undefined;
  const raw = line.slice(line.indexOf('=') + 1).trim();
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  const value = quoted ? (quoted[2] ?? '').replace(/\\(.)/g, '$1') : raw;
  return value.trim() || undefined;
}

/**
 * Linux by its distribution: PRETTY_NAME from os-release (`Ubuntu 24.04.1 LTS`), else NAME and
 * VERSION_ID, else the kernel (`Linux 6.8.0-45-generic`) when there is no os-release at all.
 */
export function linuxSystem(osRelease: string | undefined, kernelRelease: string): string {
  if (osRelease) {
    const pretty = osReleaseValue(osRelease, 'PRETTY_NAME');
    if (pretty) return pretty;
    const name = osReleaseValue(osRelease, 'NAME');
    const version = osReleaseValue(osRelease, 'VERSION_ID');
    if (name) return version ? `${name} ${version}` : name;
  }
  return `Linux ${kernelRelease.trim()}`;
}

function swVers(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/bin/sw_vers', ['-productVersion'], { timeout: 3000 }, (error, stdout) =>
      resolve(error ? '' : stdout),
    );
  });
}

async function readOsRelease(): Promise<string | undefined> {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text) return text;
  }
  return undefined;
}

/**
 * This computer's OS by name and version, as a person reads it, for the gateway to show on its
 * machine record. It never throws: whatever cannot be read falls back to the OS family and its
 * kernel release.
 */
export async function detectSystem(platform = process.platform): Promise<string> {
  const kernel = release();
  try {
    if (platform === 'darwin')
      return printable(macosSystem(await swVers()) ?? `macOS (Darwin ${kernel})`);
    if (platform === 'win32') return printable(windowsSystem(kernel));
    if (platform === 'linux') return printable(linuxSystem(await readOsRelease(), kernel));
  } catch {
    // Fall through to the family and kernel below.
  }
  return printable(`${platform} ${kernel}`);
}

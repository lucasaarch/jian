import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureTrustedKnownHosts } from './known-hosts.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const missing = async (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });

/** True when the file looks like an OpenSSH/PEM private key (not a public key or metadata). */
async function looksLikePrivateKey(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(80);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(header.toString('utf8', 0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Private keys the profile may use for git SSH: top-level `~/.ssh/*` identities and Jian-managed
 * keys under `~/.ssh/jian/<id>/`. Order is stable so IdentityFile preference does not flicker.
 */
export async function listProfileSshIdentities(sshDir: string): Promise<string[]> {
  const entry = await missing(sshDir);
  if (!entry?.isDirectory()) return [];

  const keys: string[] = [];

  for (const item of await readdir(sshDir, { withFileTypes: true })) {
    if (item.isFile()) {
      const path = join(sshDir, item.name);
      if (await looksLikePrivateKey(path)) keys.push(path);
      continue;
    }

    if (!item.isDirectory() || item.name !== 'jian') continue;

    const managed = join(sshDir, 'jian');
    for (const child of await readdir(managed, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const path = join(managed, child.name, 'id_ed25519');
      if ((await missing(path))?.isFile() && (await looksLikePrivateKey(path))) {
        keys.push(path);
      }
    }
  }

  return keys.sort((a, b) => a.localeCompare(b));
}

/** Build the GIT_SSH_COMMAND that points OpenSSH at the profile's config, known_hosts and keys. */
export function buildGitSshCommand(options: {
  knownHosts: string;
  identities: string[];
  configPath?: string;
}): string {
  return [
    '/usr/bin/ssh',
    ...(options.configPath ? ['-F', options.configPath] : []),
    '-o',
    `UserKnownHostsFile=${options.knownHosts}`,
    '-o',
    'IdentitiesOnly=yes',
    ...options.identities.flatMap((key) => ['-i', key]),
  ]
    .map(quote)
    .join(' ');
}

export type ProfileSshAccess = {
  /** Absolute path of the profile `.ssh` directory when it exists. */
  sshDir?: string;
  knownHosts: string;
  identities: string[];
  sshCommand: string;
};

/**
 * Seed trusted host keys and assemble the SSH identity used for `git` in this profile workspace.
 * Safe to call when `.ssh` is missing: known_hosts is created and the command still prefers it.
 */
export async function prepareProfileSshAccess(home: string): Promise<ProfileSshAccess> {
  const knownHosts = await ensureTrustedKnownHosts(home);
  const sshDir = join(home, '.ssh');
  const sshEntry = await missing(sshDir);
  const identities = sshEntry?.isDirectory() ? await listProfileSshIdentities(sshDir) : [];
  const config = join(sshDir, 'config');
  const configPath = (await missing(config))?.isFile() ? config : undefined;

  return {
    ...(sshEntry?.isDirectory() ? { sshDir } : {}),
    knownHosts,
    identities,
    sshCommand: buildGitSshCommand({ knownHosts, identities, configPath }),
  };
}

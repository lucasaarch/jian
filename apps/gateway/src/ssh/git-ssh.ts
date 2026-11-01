import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { onOwnerComputer, workspaceHome } from '../agent/workspace-home.js';
import { keysDirectory } from './keys-directory.js';
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

/** The managed keys in a folder of them, `<id>/id_ed25519`. */
async function managedIdentities(root: string): Promise<string[]> {
  const keys: string[] = [];

  for (const child of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!child.isDirectory()) continue;
    const path = join(root, child.name, 'id_ed25519');
    if ((await missing(path))?.isFile() && (await looksLikePrivateKey(path))) {
      keys.push(path);
    }
  }

  return keys;
}

/**
 * Private keys a server's agents may use for git SSH: top-level `~/.ssh/*` identities and
 * Jian-managed keys under `~/.ssh/jian/<id>/`. Order is stable so IdentityFile preference does not
 * flicker. Never call it on a desktop: there `~/.ssh` is the owner's.
 */
export async function listHomeSshIdentities(sshDir: string): Promise<string[]> {
  const entry = await missing(sshDir);
  if (!entry?.isDirectory()) return [];

  const keys: string[] = [];

  for (const item of await readdir(sshDir, { withFileTypes: true })) {
    if (item.isFile()) {
      const path = join(sshDir, item.name);
      if (await looksLikePrivateKey(path)) keys.push(path);
    } else if (item.isDirectory() && item.name === 'jian') {
      keys.push(...(await managedIdentities(join(sshDir, 'jian'))));
    }
  }

  return keys.sort((a, b) => a.localeCompare(b));
}

/** Build the GIT_SSH_COMMAND that points OpenSSH at this config, known_hosts and keys. */
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

/** What OpenSSH tries when nothing names an identity; `-i` turns its own list of them off. */
const DEFAULT_IDENTITIES = ['id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519', 'id_ed25519_sk'];

/**
 * On a desktop the managed keys join the owner's SSH setup and replace none of it. No `-F`, so
 * their `~/.ssh/config` applies. No `IdentitiesOnly`, so their agent keeps offering its keys. Their
 * default identities are named, because `-i` would otherwise drop them; ssh skips a missing one
 * quietly under `-o` where it warns under `-i`, and Jian never opens any of them. Their known hosts
 * still count, but ours is first, which is the one OpenSSH adds a new host to.
 */
export function buildOwnerGitSshCommand(options: {
  home: string;
  knownHosts: string;
  identities: string[];
}): string {
  const ssh = join(options.home, '.ssh');
  const files = [options.knownHosts, join(ssh, 'known_hosts'), join(ssh, 'known_hosts2')];

  return [
    '/usr/bin/ssh',
    '-o',
    // The value holds several paths, and macOS keeps app data under "Application Support".
    `UserKnownHostsFile=${files.map((file) => `"${file}"`).join(' ')}`,
    ...options.identities.flatMap((key) => ['-i', key]),
    ...DEFAULT_IDENTITIES.flatMap((name) => ['-o', `IdentityFile="${join(ssh, name)}"`]),
  ]
    .map(quote)
    .join(' ');
}

/**
 * The GIT_SSH_COMMAND for this host, seeding the known_hosts it uses.
 *
 * On a server, the identities in the shared `HOME`. Safe to call when `.ssh` is missing:
 * known_hosts is created and the command still prefers it.
 *
 * On a desktop, nothing at all until the installation has a key: the variable overrides the owner's
 * `core.sshCommand`, which then stays in force, with nothing of Jian's in the way.
 */
export async function gitSshCommand(): Promise<string | undefined> {
  const managed = await keysDirectory();
  const home = await workspaceHome();

  if (onOwnerComputer()) {
    const identities = (await managedIdentities(managed)).sort((a, b) => a.localeCompare(b));
    if (!identities.length) return undefined;

    const knownHosts = await ensureTrustedKnownHosts(join(managed, 'known_hosts'));

    return buildOwnerGitSshCommand({ home, knownHosts, identities });
  }

  const sshDir = join(home, '.ssh');
  const knownHosts = await ensureTrustedKnownHosts(join(sshDir, 'known_hosts'));
  const identities = await listHomeSshIdentities(sshDir);
  const config = join(sshDir, 'config');
  const configPath = (await missing(config))?.isFile() ? config : undefined;

  return buildGitSshCommand({ knownHosts, identities, configPath });
}

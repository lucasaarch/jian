import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { type FileHandle, mkdir, open, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { onOwnerComputer, ownerComputer, workspaceHome, workspacesRoot } from './workspace-home.js';

/**
 * What an agent's commands and file tools may touch. Every agent of an installation shares one
 * filesystem (see workspace-home.ts); what is held off here is the gateway, not other agents.
 *
 * On a server, the line is the shared directory, and two mechanisms hold it:
 *
 * - A command runs under `jian-sandbox`, which asks the kernel (Landlock) to allow writes in that
 *   directory only, reads of the system's tools besides, and nothing else: not the gateway's
 *   files, not the gateway's process in /proc. Landlock needs no privilege, so it works where
 *   user namespaces and a second container do not: Kubernetes, PaaS hosts, a container with
 *   no-new-privileges.
 * - The file tools, `send_file` and `save_attachment` run inside the gateway, not in a command,
 *   so the same line is checked here: the real path, symlinks resolved, and for a file actually
 *   opened, the path of the open descriptor.
 *
 * A kernel without Landlock (before 5.13, or with it left out of the LSM list) still gets the
 * checks on the file tools, but its commands are not confined; the gateway says so in its log
 * once. The network is not confined either way.
 *
 * On a desktop, the local gateway works for the owner on the owner's own computer, and the file
 * tools reach whatever the owner's user can, except Jian's own data: the database and credentials
 * in the app's data directory. That refusal binds the file tools ONLY. Commands are not confined
 * on a desktop, so a command can read those files, and they keep Jian's data from a careless or
 * misled tool call rather than from a determined agent. Do not describe it as more than that.
 */

/** The system a file tool on a server may read: its programs, libraries and configuration. */
const SYSTEM = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/etc',
  '/opt',
  // macOS resolves /etc through /private; the file tools check the resolved path.
  ...(process.platform === 'darwin' ? ['/private/etc'] : []),
];

/**
 * A command also reads /proc and /sys, which runtimes ask for their CPU count and their own
 * state. Landlock refuses a sandboxed process the private files of any process outside its
 * sandbox (`environ`, `mem`, `fd`), so the gateway's stay closed.
 */
const COMMAND_READS = [...SYSTEM, '/proc', '/sys', '/dev'];

/** The devices a shell writes to. /dev/shm is left out: it is memory outside the shared directory. */
const DEVICES = [
  '/dev/null',
  '/dev/zero',
  '/dev/full',
  '/dev/random',
  '/dev/urandom',
  '/dev/tty',
  '/dev/ptmx',
  '/dev/pts',
];

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

/** The real path of something that may not exist yet: symlinks of the part that exists, resolved. */
async function realOf(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);

  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const parent = dirname(current);

      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) {
        throw error;
      }

      missing.push(basename(current));
      current = parent;
    }
  }
}

export type Access = 'read' | 'write';

/**
 * The owner's folders the tool running now may reach, held for the length of its call so that every
 * check below sees them, whoever asks, and no other conversation does.
 */
const openFolders = new AsyncLocalStorage<readonly string[]>();

/** Runs a tool with these folders within reach. They must be real paths: see `realFolders`. */
export const withFolders = <T>(folders: readonly string[], work: () => T): T =>
  openFolders.run(folders, work);

/** The folders within reach now; a command starts in the first. */
export const reachableFolders = (): readonly string[] => openFolders.getStore() ?? [];

/** What a chat's folders really are, since the checks compare real paths. */
export const realFolders = (folders: readonly string[]) => Promise.all(folders.map(realOf));

/**
 * What the file tools refuse on a desktop, as real paths, or undefined on a server. Besides the
 * app's data: the gateway's process and the app that started it, whose environment and memory on
 * Linux hold the master key, and the descriptors the gateway itself has open, which on macOS are
 * no symlink a real path would resolve.
 */
export async function jianData(): Promise<{ closed: string[]; open: string } | undefined> {
  const local = ownerComputer();
  if (!local) return undefined;

  return {
    closed: [
      await realOf(local.appData),
      `/proc/${process.pid}`,
      `/proc/${process.ppid}`,
      '/dev/fd',
    ],
    // What agents worked in before: earlier work and the paths recorded in it stay valid.
    open: await realOf(workspacesRoot()),
  };
}

async function assertWithin(real: string, access: Access, asked: string) {
  const data = await jianData();

  if (data) {
    // The folder left open is checked on the real path, so a link in it leads nowhere closed.
    if (!inside(real, data.open) && data.closed.some((root) => inside(real, root))) {
      throw new Error(
        `${asked} is Jian's own data (its database and credentials), which the file tools do not open. Everything else this computer's user can reach is open to them.`,
      );
    }
    return;
  }

  const home = await workspaceHome();
  const allowed = [...(access === 'write' ? [home] : [home, ...SYSTEM]), ...reachableFolders()];

  if (!allowed.some((root) => inside(real, root))) {
    throw new Error(
      access === 'write'
        ? `${asked} is outside the directory the agents share. Write only under ${home}`
        : `${asked} is outside the directory the agents share. Read only under ${home}, or the system directories (${SYSTEM.join(', ')})`,
    );
  }
}

/** The real path, refused when it leads out of what the file tools may reach. */
export async function confine(path: string, access: Access): Promise<string> {
  const real = await realOf(path);

  await assertWithin(real, access, path);

  return real;
}

/**
 * Checked again on the descriptor: a symlink swapped in after `confine` would otherwise send the
 * gateway to a file it may not touch. Where /proc is missing, as on macOS, there is no asking a
 * descriptor for its path, so the path is resolved again and must still be the same file: a swap
 * undone in between can slip past that, which a desktop's unconfined commands could do anyway.
 */
async function assertOpened(handle: FileHandle, real: string, access: Access, path: string) {
  const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);

  if (opened !== undefined) {
    await assertWithin(opened, access, path);
    return;
  }

  const again = await realOf(real);

  await assertWithin(again, access, path);

  const [held, there] = await Promise.all([handle.stat(), stat(real)]);

  if (again !== real || held.dev !== there.dev || held.ino !== there.ino) {
    throw new Error(`${path} changed while it was being opened; try again`);
  }
}

/** Opens a file to read, only when it is within reach. The caller closes it. */
export async function openToRead(path: string): Promise<FileHandle> {
  const real = await confine(path, 'read');
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    await assertOpened(handle, real, 'read', path);
  } catch (error) {
    await handle.close();
    throw error;
  }

  return handle;
}

/**
 * Writes a whole file within reach, creating its folders. `exclusive` refuses a file that already
 * exists. The file is truncated only after the descriptor is known to be within reach.
 */
export async function writeInWorkspace(
  path: string,
  data: string | Uint8Array,
  { exclusive = false }: { exclusive?: boolean } = {},
): Promise<string> {
  const real = await confine(path, 'write');

  await mkdir(dirname(real), { recursive: true });

  const handle = await open(
    real,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (exclusive ? constants.O_EXCL : 0),
    0o644,
  );

  try {
    await assertOpened(handle, real, 'write', path);
    await handle.truncate(0);
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }

  return real;
}

/** Where the confinement helper is; the image builds it into this path. */
const helper = () => process.env.JIAN_SANDBOX || '/usr/local/bin/jian-sandbox';

const probes = new Map<string, Promise<number>>();

/** The Landlock ABI commands are confined with, or 0 when they cannot be. Asked once per helper. */
export function sandboxAbi(): Promise<number> {
  const path = helper();
  let probe = probes.get(path);

  if (!probe) {
    probe = new Promise<number>((done) => {
      execFile(path, ['--abi'], { timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
        const abi = error ? 0 : Number.parseInt(stdout.trim(), 10) || 0;

        if (abi < 1) {
          console.warn(
            `Shell commands run without Landlock confinement: ${error ? `${path} is not available` : 'this kernel does not offer it'}. The file tools still keep to the shared directory, but a command can read what the gateway's user can.`,
          );
        }

        done(abi);
      });
    });
    probes.set(path, probe);
  }

  return probe;
}

/**
 * The program and arguments that run `program` confined to `home`, or unchanged when this
 * kernel offers no confinement. On a desktop a command is never confined, whatever is installed:
 * it runs as the owner, on the owner's work, and a helper found on the PATH must not change that.
 */
export async function confined(
  home: string,
  program: string,
  args: string[],
  extra: { readOnly?: string[]; writable?: string[] } = {},
): Promise<{ file: string; args: string[] }> {
  if (onOwnerComputer() || (await sandboxAbi()) < 1) {
    return { file: program, args };
  }

  return {
    file: helper(),
    args: [
      ...[...COMMAND_READS, ...(extra.readOnly ?? [])].flatMap((path) => ['--ro', path]),
      ...[home, ...DEVICES, ...(extra.writable ?? [])].flatMap((path) => ['--rw', path]),
      '--',
      program,
      ...args,
    ],
  };
}

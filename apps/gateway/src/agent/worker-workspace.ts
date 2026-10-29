import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { Run } from '@jian/contracts';
import { prepareProfileSshAccess } from '../ssh/git-ssh.js';
import { workerWorkspacePath, workspaceOf } from './workspace.js';

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

const directory = async (path: string) => {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await stat(path)).isDirectory()) throw new Error('Profile config directory is invalid');
};

export type WorkerGitAccess = {
  readOnly: string[];
  writable: string[];
  sshCommand?: string;
};

/** What writes the installation's SSH keys into a workspace before git can use them. */
export type SshKeySync = { sync(home: string): Promise<void> };

/** Seed known_hosts, write the installation's keys and wire GIT_SSH_COMMAND for the shell. */
export async function prepareProfileGitAccess(
  profileId: string,
  keys?: SshKeySync,
): Promise<WorkerGitAccess> {
  const home = await workspaceOf(profileId);
  await keys?.sync(home);
  const ssh = await prepareProfileSshAccess(home);
  const access: WorkerGitAccess = {
    readOnly: [],
    writable: [],
    sshCommand: ssh.sshCommand,
  };
  const config = join(home, '.config');
  await directory(config);
  access.writable.push(config);
  return access;
}

/**
 * Subagents share the principal's profile workspace. Git/SSH matches the principal;
 * optional `repositories` are named roots in that home, not detached worktrees Jian creates.
 * If a task needs isolation, the agent creates a normal `git worktree` inside the project.
 */
export async function prepareWorkerWorkspace(
  run: Run,
  keys?: SshKeySync,
): Promise<WorkerGitAccess> {
  if (!run.subagent) return { readOnly: [], writable: [] };

  const access = await prepareProfileGitAccess(run.profileId, keys);
  const profileHome = await workspaceOf(run.profileId);

  for (const [index, asked] of (run.subagent.repositories ?? []).entries()) {
    let source: string;
    try {
      source = await realpath(asked);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error(
          `Repository ${index + 1} cannot be accessed at ${asked}; use a path inside this profile's workspace, not /root or another user's directory`,
        );
      }
      if (code === 'ENOENT') {
        throw new Error(`Repository ${index + 1} does not exist at ${asked}`);
      }
      throw error;
    }
    if (!inside(source, profileHome) || !(await stat(source)).isDirectory()) {
      throw new Error(`Repository ${index + 1} must be inside this agent's workspace`);
    }
  }

  return access;
}

/**
 * Remove leftover per-run worker homes from older Jian versions that used isolated worktrees.
 * Current subagents share the profile workspace and do not create these directories.
 */
export async function removeWorkerWorkspace(
  profileId: string,
  workerId: string,
  _repositories: string[] = [],
): Promise<void> {
  const home = workerWorkspacePath(profileId, workerId);
  await rm(home, { recursive: true, force: true });
}

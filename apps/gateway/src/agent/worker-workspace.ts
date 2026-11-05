import { realpath, stat } from 'node:fs/promises';
import type { Run } from '@jian/contracts';
import { gitSshCommand } from '../ssh/git-ssh.js';
import { confine } from './workspace.js';
import { onOwnerComputer } from './workspace-home.js';

export type WorkerGitAccess = {
  readOnly: string[];
  writable: string[];
  sshCommand?: string;
};

/** What writes the installation's SSH keys where git finds them, before git can use them. */
export type SshKeySync = { sync(): Promise<void> };

/** Writes the installation's keys and wires GIT_SSH_COMMAND for the shell, when it needs wiring. */
export async function prepareGitAccess(keys?: SshKeySync): Promise<WorkerGitAccess> {
  await keys?.sync();
  const sshCommand = await gitSshCommand();

  return { readOnly: [], writable: [], ...(sshCommand ? { sshCommand } : {}) };
}

/**
 * Subagents share the filesystem of every agent. Git/SSH matches the principal; optional
 * `repositories` are named roots there. A task that needs a checkout of its own gets one with
 * `create_worktree` where the run has it, never with `git worktree` by hand, so Jian knows of it.
 */
export async function prepareWorkerWorkspace(
  run: Run,
  keys?: SshKeySync,
): Promise<WorkerGitAccess> {
  if (!run.subagent) return { readOnly: [], writable: [] };

  const access = await prepareGitAccess(keys);

  for (const [index, asked] of (run.subagent.repositories ?? []).entries()) {
    let source: string;
    try {
      source = await realpath(asked);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error(
          `Repository ${index + 1} cannot be accessed at ${asked}; use a path this gateway's user can read`,
        );
      }
      if (code === 'ENOENT') {
        throw new Error(`Repository ${index + 1} does not exist at ${asked}`);
      }
      throw error;
    }
    // The same line the file tools hold: a worker is sent nowhere it could not write.
    const reachable = await confine(source, 'write').then(
      () => true,
      () => false,
    );
    if (!reachable || !(await stat(source)).isDirectory()) {
      throw new Error(
        `Repository ${index + 1} must be ${onOwnerComputer() ? "a folder outside Jian's own data" : 'a folder inside the directory the agents share'}`,
      );
    }
  }

  return access;
}

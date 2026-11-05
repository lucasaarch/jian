import { createHash } from 'node:crypto';
import type { GitPlace } from '../agent/github-git-place.js';
import { GatewayError } from '../core/errors.js';

/** A refusal the agent or the owner can act on; the message carries the next step. */
export class WorktreeProblem extends GatewayError {
  constructor(message: string) {
    super(409, message);
  }
}

/**
 * Git that changes a checkout runs with the repository's own hooks and filters, as the owner's git
 * would, so LFS and commit hooks keep working. The place has no environment channel that reaches a
 * worker, so what GIT_EDITOR=true would do is said in arguments. Prompts are already off on the
 * gateway (`GIT_TERMINAL_PROMPT`); a worker's shell has no terminal to prompt on.
 */
const NO_EDITOR = ['-c', 'core.editor=true'];

async function git(place: GitPlace, args: string[], allowFailure = false) {
  const outcome = await place.git(args);
  if (outcome.timedOut) throw new WorktreeProblem('git took too long and was stopped.');
  if (outcome.exitCode !== 0 && !allowFailure) {
    const line = outcome.stderr.trim().split('\n')[0] || outcome.stdout.trim().split('\n')[0];
    throw new WorktreeProblem(line || `git ${args[0]} failed.`);
  }
  return outcome;
}

/** Where a conversation's worktrees of one source live; the tail keeps same-named folders apart. */
export async function worktreeRoot(place: GitPlace, source: string): Promise<string> {
  const base = source.split(/[\\/]/).filter(Boolean).at(-1) ?? 'source';
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 8);
  return place.join(await place.home(), 'worktrees', `${base}-${digest}`);
}

export async function sourceOf(
  place: GitPlace,
  folder: string,
): Promise<{ top: string; branch: string }> {
  const top = (
    await git(place, ['-C', folder, 'rev-parse', '--show-toplevel'], true)
  ).stdout.trim();
  if (!top) throw new WorktreeProblem(`${folder} is not a git repository.`);

  const branch = (await git(place, ['-C', top, 'branch', '--show-current'])).stdout.trim();
  if (!branch) throw new WorktreeProblem('detached HEAD: check out a branch first.');
  return { top, branch };
}

export async function addWorktree(
  place: GitPlace,
  input: { source: string; path: string; branch: string; base: string },
): Promise<void> {
  await git(place, [
    ...NO_EDITOR,
    '-C',
    input.source,
    'worktree',
    'add',
    '-b',
    input.branch,
    '--',
    input.path,
    input.base,
  ]);
}

/** Changed entries, `-z` so odd file names survive; a rename lists its old name as an extra entry. */
async function uncommittedIn(place: GitPlace, path: string, untracked = true) {
  const flag = untracked ? '--untracked-files=all' : '--untracked-files=no';
  const out = (await git(place, ['-C', path, 'status', '--porcelain=v1', '-z', flag])).stdout;
  const entries = out.split('\0').filter(Boolean);
  let count = 0;
  for (let i = 0; i < entries.length; i += 1) {
    count += 1;
    if (/^[RC]/.test(entries[i] ?? '')) i += 1;
  }
  return count;
}

export async function worktreeState(
  place: GitPlace,
  input: { path: string; base: string },
): Promise<{ ahead: number; behind: number; uncommitted: number }> {
  const counts = await git(place, [
    '-C',
    input.path,
    'rev-list',
    '--left-right',
    '--count',
    `${input.base}...HEAD`,
  ]);
  const [behind = 0, ahead = 0] = counts.stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind, uncommitted: await uncommittedIn(place, input.path) };
}

export async function updateWorktree(
  place: GitPlace,
  input: { path: string; base: string; strategy: 'merge' | 'rebase' },
): Promise<{ conflicts: string[] }> {
  if ((await uncommittedIn(place, input.path)) > 0) {
    throw new WorktreeProblem(
      'The worktree has uncommitted changes. Commit them before updating from the base.',
    );
  }

  const command =
    input.strategy === 'merge' ? ['merge', '--no-edit', input.base] : ['rebase', input.base];
  const outcome = await git(place, [...NO_EDITOR, '-C', input.path, ...command], true);
  if (outcome.exitCode === 0) return { conflicts: [] };

  const listed = await git(
    place,
    ['-C', input.path, 'diff', '--name-only', '--diff-filter=U', '-z'],
    true,
  );
  const conflicts = listed.stdout.split('\0').filter(Boolean);
  if (conflicts.length === 0) {
    throw new WorktreeProblem(outcome.stderr.trim().split('\n')[0] || 'The update failed.');
  }
  return { conflicts };
}

export async function mergeWorktree(
  place: GitPlace,
  input: { source: string; path: string; branch: string; base: string },
): Promise<{ sha: string }> {
  if ((await uncommittedIn(place, input.path)) > 0) {
    throw new WorktreeProblem(
      'The worktree has uncommitted changes. Commit them in the worktree, then merge.',
    );
  }
  // Untracked files in the source are the owner's business; only tracked edits can collide.
  if ((await uncommittedIn(place, input.source, false)) > 0) {
    throw new WorktreeProblem(
      'The source folder has uncommitted changes. Ask the owner to commit or stash them, then merge.',
    );
  }

  const current = (
    await git(place, ['-C', input.source, 'branch', '--show-current'])
  ).stdout.trim();
  if (current !== input.base) {
    throw new WorktreeProblem(
      `The source folder is on ${current || 'a detached HEAD'}, but this worktree was made from ${input.base}. ` +
        `Ask the owner to check out ${input.base} in the source folder, then merge.`,
    );
  }

  const contains = await git(
    place,
    ['-C', input.source, 'merge-base', '--is-ancestor', input.base, input.branch],
    true,
  );
  if (contains.exitCode !== 0) {
    throw new WorktreeProblem(
      `${input.branch} does not contain the latest ${input.base}: run update_worktree first, then merge.`,
    );
  }

  const merged = await git(
    place,
    [...NO_EDITOR, '-C', input.source, 'merge', '--no-ff', '--no-edit', input.branch],
    true,
  );
  if (merged.exitCode !== 0) {
    // Never leave the owner's folder mid-merge.
    await git(place, ['-C', input.source, 'merge', '--abort'], true);
    throw new WorktreeProblem(
      merged.stderr.trim().split('\n')[0] ||
        merged.stdout.trim().split('\n')[0] ||
        'The merge failed.',
    );
  }
  return { sha: (await git(place, ['-C', input.source, 'rev-parse', 'HEAD'])).stdout.trim() };
}

export async function removeWorktree(
  place: GitPlace,
  input: {
    source: string;
    path: string;
    branch: string;
    base: string;
    discard: boolean;
    deleteBranch: boolean;
  },
): Promise<{ branchKept: boolean }> {
  if (!input.discard && (await uncommittedIn(place, input.path)) > 0) {
    throw new WorktreeProblem(
      'The worktree has uncommitted changes. Commit them, or discard them to remove the worktree anyway.',
    );
  }

  await git(place, [
    '-C',
    input.source,
    'worktree',
    'remove',
    ...(input.discard ? ['--force'] : []),
    '--',
    input.path,
  ]);

  // Merged means every commit of the branch is in the base, so a deletion cannot lose work. `-D`
  // because `-d` also checks the upstream, and refuses a branch pushed for a pull request.
  const merged =
    (
      await git(
        place,
        ['-C', input.source, 'merge-base', '--is-ancestor', input.branch, input.base],
        true,
      )
    ).exitCode === 0;

  if (!input.deleteBranch && !merged) return { branchKept: true };
  // The worktree is gone by now; a branch that will not delete is kept, never an error.
  const deleted = await git(place, ['-C', input.source, 'branch', '-D', '--', input.branch], true);
  return { branchKept: deleted.exitCode !== 0 };
}

/**
 * The worktrees git lists for a source, by real path. One whose folder was deleted by hand is still
 * listed, marked `prunable`, until git prunes it; it is not there, so it is left out.
 */
export async function listedWorktrees(place: GitPlace, source: string): Promise<Set<string>> {
  const out = (await git(place, ['-C', source, 'worktree', 'list', '--porcelain'])).stdout;
  const listed = new Set<string>();
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '));
    if (path && !lines.some((line) => line === 'prunable' || line.startsWith('prunable '))) {
      listed.add(path.slice('worktree '.length));
    }
  }
  return listed;
}

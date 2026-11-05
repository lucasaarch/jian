import type { Skill } from '@jian/contracts';

export const worktrees: Skill = {
  name: 'worktrees',
  description:
    'Use when working in a folder or checkout another conversation may share, when the context says someone else works there, or when asked to merge, update or remove a worktree.',
  instructions: `# Worktrees

A worktree is your own checkout of a repository: a folder outside it and a branch \`jian/<name>\`
from the branch the owner has checked out. Your edits stay there until the owner or you merge them,
so nobody's work lands in a half-finished state.

## Read the signal first

For each folder you work in, your instructions say how many files have uncommitted changes, who
else works there and whether you have a worktree for it. Act on it before you edit:

- **Another agent or conversation works there:** call \`create_worktree\` with the folder before
  your first edit.
- **Only the owner's changes are there:** ask before you touch the folder. They may be the subject
  of the request, and a worktree would not contain them.
- **Clean and alone:** work in place. Make a worktree only when the owner asks, or when you expect
  to leave the work half done for a while.

The count is up to a minute old. It is a reason to ask, not proof that nothing changed.

## While you have one

\`create_worktree\` names it and the branch for you. From then on your file tools refuse writes in
the source folder and your commands start in the worktree, so use paths inside it. Do not write in
the source in any other way either, \`run_command\` included, and never run \`git worktree\` by
hand: the tools keep what Jian knows in step with git.

A conversation on a machine has no file tools there. Run commands with \`cwd\` set to the
worktree's path. \`list_worktrees\` gives the name, branch, base, source and path of each, with
commits ahead and behind and uncommitted files.

## Bringing the work back

Merge only when the owner asked, or, for a subagent's own worktree, when its work is done.

1. Commit everything in the worktree. \`merge_worktree\` and \`update_worktree\` refuse otherwise.
2. If \`list_worktrees\` shows it behind, call \`update_worktree\`. It merges the base in by default;
   pass \`strategy: "rebase"\` when the owner prefers a straight history.
3. Call \`merge_worktree\`. It merges into the source folder, then removes the worktree and the
   merged branch.

\`update_worktree\` can stop on conflicts, which stay in the worktree and are listed. Resolve them
there, add the files and finish with \`git -c core.editor=true rebase --continue\` after a rebase
or \`git commit --no-edit\` after a merge. Without those, git opens an editor and the command
hangs.

\`merge_worktree\` refuses when the source folder has uncommitted changes or another branch
checked out. Tell the owner which, and ask them to commit, stash or switch back. Do not clean the
source up yourself.

\`remove_worktree\` keeps a branch that holds commits the base lacks. Pass \`discard\` or
\`deleteBranch\` only when the owner asked to throw work away.

## Approval

Under Ask first, \`create_worktree\`, \`update_worktree\`, \`merge_worktree\` and
\`remove_worktree\` wait for the owner like \`run_command\` does. Say what you are about to do and
why. \`list_worktrees\` only reads.

## Subagents

A subagent makes its own worktree from the conversation's: pass the owner's folder, or the
conversation's worktree path, and it lands in the conversation's worktree. It merges back into that
worktree with \`merge_worktree\` and does not touch the owner's folder. A subagent of a
conversation on a machine cannot create one; it uses the conversation's worktrees through the other
tools.

The panel shows only the conversation's own worktrees. If a subagent never merges, its worktree is
left behind, so ask for the merge in its brief.`,
};

import type { Skill } from '@jian/contracts';

type Can = {
  /** The run has `create_worktree`: not a conversation with only a clone folder, nor a machine's subagent. */
  create: boolean;
  /** The conversation targets a machine, whose disk the file tools do not reach. */
  machine: boolean;
  subagent: boolean;
};

const DESCRIPTION =
  'Use when working in a folder or checkout another conversation may share, when the context says someone else works there, or when asked to merge, update or remove a worktree.';

const INTRO = `# Worktrees

A worktree is a checkout of a repository of its own: a folder outside it and a branch \`jian/<name>\`
from the branch the owner has checked out. Work done there stays there until it is merged, so
nobody's work lands half finished.`;

const SIGNAL = `## Read the signal first

At the start of each turn, a line per folder you work in says how many files have uncommitted
changes, who else works there and whether you have a worktree for it. Act on it before you edit:

- **Another agent or conversation works there:** call \`create_worktree\` with the folder before
  your first edit.
- **Only the owner's changes are there:** ask before you touch the folder. They may be the subject
  of the request, and a worktree would not contain them.
- **Clean and alone:** work in place. Make a worktree only when the owner asks, or when you expect
  to leave the work half done for a while.

The count is up to a minute old. It is a reason to ask, not proof that nothing changed.`;

function whileYouHaveOne({ create, machine }: Can): string {
  const made = create
    ? '`create_worktree` names the worktree and the branch for you. '
    : 'The conversation names them. ';
  const where = machine
    ? `The worktrees are on the machine, and your file tools do not reach them: run commands there
with \`run_remote_command\`, setting its \`cwd\` to the worktree's path and never to the source
folder.`
    : `From then on your file tools refuse writes in the source folder and your commands start in the
worktree, so use paths inside it. Do not write in the source in any other way either, \`run_command\`
included.`;
  return `## While you have one

${made}${where} Never run \`git worktree\` by hand: the tools keep what Jian knows in step with git.
\`list_worktrees\` gives the name, branch, base, source and path of each, with commits ahead and
behind and uncommitted files.`;
}

const bringingBack = ({ create, subagent }: Can) => `## Bringing the work back

Merge only when the owner asked${create && subagent ? ', or, for your own worktree, when your work in it is done' : ''}.

1. Commit everything in the worktree. \`merge_worktree\` and \`update_worktree\` refuse otherwise.
2. If \`list_worktrees\` shows it behind, call \`update_worktree\`. It merges the base in by default;
   pass \`strategy: "rebase"\` when the owner prefers a straight history.
3. Call \`merge_worktree\`. It merges into the folder the worktree came from, then removes the
   worktree and the merged branch.

\`update_worktree\` can stop on conflicts, which stay in the worktree and are listed. Resolve them
there, add the files and finish with \`git -c core.editor=true rebase --continue\` after a rebase
or \`git commit --no-edit\` after a merge. Without those, git opens an editor and the command
hangs.

\`merge_worktree\` refuses when the folder it merges into has uncommitted changes or another branch
checked out. Tell the owner which, and ask them to commit, stash or switch back. Do not clean the
folder up yourself.

\`remove_worktree\` keeps a branch that holds commits the base lacks. Pass \`discard\` or
\`deleteBranch\` only when the owner asked to throw work away.
`;

const approval = (create: boolean) => `## Approval

Under Ask first, ${create ? '`create_worktree`, ' : ''}\`update_worktree\`, \`merge_worktree\` and
\`remove_worktree\` wait for the owner like \`run_command\` does. Say what you are about to do and
why. \`list_worktrees\` only reads.`;

function subagents({ create, machine, subagent }: Can): string {
  if (subagent) {
    return create
      ? `## As a subagent

\`create_worktree\` makes yours from the conversation's worktree when it has one for that
repository, and from the folder you pass otherwise. \`merge_worktree\` brings it back to where it
came from. Merge when your work in it is done, and say so in your report.`
      : `## As a subagent

The conversation's worktrees are listed by \`list_worktrees\`. Work in the one your brief names and
${machine ? 'run commands there with `run_remote_command`, setting its `cwd` to the worktree path' : 'pass its path explicitly when a tool asks where to run'}.`;
  }
  if (create && machine) {
    return `## Subagents

A subagent of a conversation on a machine works there through \`run_remote_command\` and cannot make
worktrees, so give subagents that edit one repository in parallel files that do not overlap.`;
  }
  return create
    ? `## Subagents

A subagent makes its own worktree from yours when you have one for the repository, and from the
folder otherwise, and merges it back with \`merge_worktree\`. The panel shows only your own. A
subagent that never merges leaves its worktree behind, so ask for the merge in its brief.`
    : '';
}

export function worktreesFor(can: Can): Skill {
  return {
    name: 'worktrees',
    description: DESCRIPTION,
    instructions: [
      INTRO,
      // Signals are given for the conversation's folders; a subagent is not given them, and
      // without a folder to make one from nothing in them could be acted on.
      ...(can.create && !can.subagent ? [SIGNAL] : []),
      whileYouHaveOne(can),
      bringingBack(can),
      approval(can.create),
      subagents(can),
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

/** As the panel lists it: with everything, which a run then narrows down to what it has. */
export const worktrees: Skill = worktreesFor({ create: true, machine: false, subagent: false });

import type { Skill } from '@jian/contracts';

type Can = {
  /** The run has `create_worktree`: not a conversation with only a clone folder, nor a machine's subagent. */
  create: boolean;
  /** The conversation targets a machine, where its worktrees are. */
  machine: boolean;
  /**
   * This run's file tools work on that machine, as its worker offers them: the same answer the
   * runtime used to give them. False for its subagents, whose file tools stay on the gateway.
   */
  files?: boolean;
  /** Its turns say, per folder, who else works there: not a subagent's, nor without a folder. */
  signals: boolean;
  subagent: boolean;
};

const DESCRIPTION =
  'Use when working in a folder or checkout another conversation may share, when the context says someone else works there, or when asked to merge, update or remove a worktree.';

const INTRO = `# Worktrees

A worktree is a checkout of a repository of its own: a folder outside it and a branch \`jian/<name>\`
from the branch the owner has checked out. Work done there stays there until it is merged, so
nobody's work lands half finished.`;

function signal({ machine }: Can): string {
  const says = machine
    ? 'who else works there and whether you have a worktree for it. Nothing counts changes on a machine, so run `git status` there with `run_remote_command` before you edit.'
    : 'how many files have uncommitted changes, who else works there and whether you have a worktree for it.';
  return `## Read the signal first

At the start of each turn, a line per folder you work in says ${says} Act on it before you edit:

- **Another agent or conversation works there:** call \`create_worktree\` with the folder before
  your first edit.
- **Only the owner's changes are there:** ask before you touch the folder. They may be the subject
  of the request, and a worktree would not contain them. Changes you made yourself in this
  conversation, in earlier turns, are not the owner's, and ${machine ? '`git status`' : 'the count'} shows them too: ask only
  about changes you did not make.
- **Clean and alone:** work in place. Make a worktree only when the owner asks, or when you expect
  to leave the work half done for a while.${
    machine
      ? ''
      : `

The count can be up to a minute old, so a file may have changed since.`
  }`;
}

/** What a run on a machine is told about its file tools there, by what it actually has. */
function onMachine({ files, subagent }: Can): string {
  if (files) {
    return `The worktrees are on the machine. Your file tools work in them and refuse writes in the
source folder, as they do on the gateway. Commands do not start in a worktree: set the \`cwd\` of
\`run_remote_command\` to the worktree's path and never to the source folder.`;
  }
  if (subagent) {
    return `The worktrees are on the machine. Your file tools and \`run_command\` act on the gateway, not
on it: run commands there with \`run_remote_command\`, setting its \`cwd\` to the worktree's path
and never to the source folder.`;
  }
  return `The worktrees are on the machine, and you have no file tools there: commands and files go
through \`run_remote_command\`, with its \`cwd\` set to the worktree's path and never to the source
folder. Updating Jian Remote on that machine (for This computer, the desktop app) gives you file
tools there.`;
}

function whileYouHaveOne(can: Can): string {
  const { create, machine } = can;
  const made = create
    ? '`create_worktree` names the worktree and the branch for you. '
    : 'The conversation names them. ';
  const where = machine
    ? onMachine(can)
    : `From then on your file tools refuse writes in the source folder and your commands start in the
worktree, so use paths inside it. Do not write in the source in any other way either, \`run_command\`
included.`;
  return `## While you have one

${made}${where} Never run \`git worktree\` by hand: the tools keep what Jian knows in step with git.
\`list_worktrees\` gives the name, branch, base, source and path of each, with commits ahead and
behind and uncommitted files.

A worktree holds only what is committed. Nothing git ignores is there, such as \`.env\`,
\`node_modules\` or build output: install or copy what the checks need before you run them, and
never commit a secret you copied in.`;
}

function whenToMerge({ create, machine, subagent }: Can): string {
  if (create && subagent) return ', or, for your own worktree, when your work in it is done';
  if (create && !machine) return ", or, for a subagent's worktree, when its work is done";
  return '';
}

const bringingBack = (can: Can) => `## Bringing the work back

Merge only when the owner asked${whenToMerge(can)}.

1. Commit everything in the worktree. \`merge_worktree\` and \`update_worktree\` refuse otherwise.
2. If \`list_worktrees\` shows it behind, call \`update_worktree\`. It merges the base in by default;
   pass \`strategy: "rebase"\` when the owner prefers a straight history.
3. Call \`merge_worktree\`. It merges into the folder the worktree came from, then removes the
   worktree and the merged branch. A merge that a hook stops, or that takes too long, is undone
   and the result says why: fix the cause in the worktree, commit, and merge again.

\`update_worktree\` can stop on conflicts, which stay in the worktree and are listed. Resolve them
there, add the files and finish with \`git -c core.editor=true rebase --continue\` after a rebase
or \`git commit --no-edit\` after a merge. Without those, git opens an editor and the command
hangs.

\`merge_worktree\` refuses when the folder it merges into has uncommitted changes or another branch
checked out. Tell the owner which, and ask them to commit, stash or switch back. Do not clean the
folder up yourself.${
  can.create && can.subagent
    ? " When that folder is the conversation's worktree, its changes are not yours to commit: report it in your final answer, so the principal agent commits them and merges your worktree."
    : ''
}

\`remove_worktree\` keeps a branch that holds commits the base lacks. Pass \`discard\` or
\`deleteBranch\` only when the owner asked to throw work away.
`;

const approval = (create: boolean) => `## Approval

Under Ask first, ${create ? '`create_worktree`, ' : ''}\`update_worktree\`, \`merge_worktree\` and
\`remove_worktree\` wait for the owner like \`run_command\` does. Say what you are about to do and
why. \`list_worktrees\` only reads.`;

function subagents(can: Can): string {
  const { create, machine, subagent } = can;
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

A subagent of a conversation on a machine works on the gateway, with the gateway's file tools and
\`run_command\`, not the machine's. It reaches the machine only through \`run_remote_command\` and
cannot make worktrees, so give subagents that edit one repository in parallel files that do not
overlap.`;
  }
  return create
    ? `## Subagents

A subagent makes its own worktree from yours when you have one for the repository, and from the
folder otherwise, and merges it back with \`merge_worktree\`. The panel shows only your own.
\`list_worktrees\` also shows your subagents', marked \`subagent: true\`, and \`merge_worktree\` and
\`remove_worktree\` act on them too. While a subagent's worktree made from yours is there, yours
cannot be merged or removed: merge or remove theirs first. A subagent that never merges leaves its
worktree behind, so ask for the merge in its brief.`
    : '';
}

export function worktreesFor(can: Can): Skill {
  return {
    name: 'worktrees',
    description: DESCRIPTION,
    instructions: [
      INTRO,
      // Without the signals, or a folder to make a worktree from, nothing in them applies.
      ...(can.create && can.signals && !can.subagent ? [signal(can)] : []),
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
export const worktrees: Skill = worktreesFor({
  create: true,
  machine: false,
  signals: true,
  subagent: false,
});

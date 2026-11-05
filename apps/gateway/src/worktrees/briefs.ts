import type { WorktreeRecord } from './repository.js';

type Named = Pick<WorktreeRecord, 'name' | 'branch' | 'base' | 'path'>;

const which = (w: Named) => `the worktree ${w.name} (branch ${w.branch})`;

export const mergeBrief = (w: Named) =>
  [
    `The owner asked you to merge ${which(w)} into ${w.base}.`,
    `Commit what is left in it, bring ${w.base} in with update_worktree if it moved,`,
    'then merge it with merge_worktree.',
    "If merge_worktree refuses because of the owner's own checkout, stop and tell them why.",
  ].join(' ');

export const updateBrief = (w: Named, strategy: 'merge' | 'rebase') =>
  [
    `The owner asked you to bring ${w.base} into ${which(w)}, by ${strategy}.`,
    `Commit what is left in it first, then call update_worktree with the name ${w.name} and strategy ${strategy}.`,
    'If it stops on conflicts, settle each one so both sides keep what they meant, run the checks',
    `that cover what you touched, \`git add\` the files you resolved, then finish from ${w.path} with`,
    strategy === 'rebase'
      ? '`git -c core.editor=true rebase --continue`.'
      : '`git -c core.editor=true commit --no-edit`.',
    'Then say in a few lines what changed.',
  ].join(' ');

export const pullRequestBrief = (w: Named, repository: string) =>
  [
    `The owner asked you to open a pull request for ${which(w)} against ${w.base}.`,
    `Commit what is left in it, then push the branch with github_git for ${repository} from ${w.path}.`,
    `Open the pull request with GitHub's MCP server (create_pull_request), with ${w.base} as its base`,
    `and ${w.branch} as its head, and write a title and description from the changes.`,
    'Then give the owner the link.',
  ].join(' ');

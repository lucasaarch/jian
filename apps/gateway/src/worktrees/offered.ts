import type { Session } from '@jian/contracts';

/**
 * Whether a conversation gets the worktree tools and skills: it has folders, a clone folder or a
 * machine to work on. One rule for the run and for the buttons, so a button never sends a brief
 * that names a tool the run does not have.
 */
export const offersWorktrees = (
  conversation: Pick<Session, 'folders' | 'cloneInto' | 'remoteMachineId'>,
) =>
  Boolean(conversation.folders?.length || conversation.cloneInto || conversation.remoteMachineId);

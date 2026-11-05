'use client';

import { useQuery } from '@tanstack/react-query';
import { panelApi } from '../lib/query/client';
import { keys } from '../lib/query/keys';

/**
 * What deleting a chat costs its worktrees: the uncommitted files, which a branch cannot keep.
 * Committed work stays on the branch, so it is said only to settle that. A worktree the gateway
 * could not read counts for nothing rather than for a guess.
 */
export function WorktreeLoss({ profileId, sessionId }: { profileId: string; sessionId: string }) {
  const { data = [] } = useQuery({
    queryKey: keys.sessionWorktrees(profileId, sessionId),
    queryFn: () => panelApi().sessionWorktrees(profileId, sessionId),
  });
  const lost = data.reduce((sum, item) => sum + (item.uncommitted ?? 0), 0);

  if (!lost) return null;

  const files = lost === 1 ? '1 uncommitted file' : `${lost} uncommitted files`;
  const [only] = data;

  return data.length === 1 && only ? (
    <>
      Its worktree {only.name} has {files}, which {lost === 1 ? 'is' : 'are'} lost. Committed work
      stays on its branch.
    </>
  ) : (
    <>
      Its worktrees have {files}, which {lost === 1 ? 'is' : 'are'} lost. Committed work stays on
      its branches.
    </>
  );
}

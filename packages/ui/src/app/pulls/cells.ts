import type { StatusTone } from '../../kit';
import type { GitHubPullRow } from '../../lib/api';

/** What a row's pills say, worked out apart from drawing them so they are tested without one. */
export type Pill = { text: string; tone: StatusTone };

/** The head commit's checks: failures first, then what is still running, then all passed. */
export function checksPill(checks: GitHubPullRow['checks']): Pill | undefined {
  if (!checks) return undefined;
  const total = checks.passing + checks.failing + checks.pending;
  if (checks.failing) return { text: `${checks.failing}/${total} failing`, tone: 'bad' };
  if (checks.pending) return { text: `${checks.pending}/${total} running`, tone: 'warn' };
  return { text: `${checks.passing}/${total} passed`, tone: 'good' };
}

/** Whether it can merge now; a draft says so before anything else. */
export function mergePill(pull: Pick<GitHubPullRow, 'draft' | 'mergeable'>): Pill {
  if (pull.draft) return { text: 'Draft', tone: 'quiet' };
  switch (pull.mergeable) {
    case 'clean':
      return { text: 'Ready', tone: 'good' };
    case 'conflicts':
      return { text: 'Conflicts', tone: 'bad' };
    case 'blocked':
      return { text: 'Blocked', tone: 'warn' };
    case 'behind':
      return { text: 'Behind', tone: 'warn' };
    default:
      return { text: 'Checking', tone: 'quiet' };
  }
}

/** The repository's review decision, when it requires one. */
export function decisionPill(decision: GitHubPullRow['reviewDecision']): Pill | undefined {
  switch (decision) {
    case 'approved':
      return { text: 'Approved', tone: 'good' };
    case 'changes_requested':
      return { text: 'Changes requested', tone: 'bad' };
    case 'review_required':
      return { text: 'Review required', tone: 'warn' };
    default:
      return undefined;
  }
}

/** A row's identity, which stays the same across reads and filters. */
export const pullKey = (pull: Pick<GitHubPullRow, 'owner' | 'repo' | 'number'>) =>
  `${pull.owner}/${pull.repo}#${pull.number}`.toLowerCase();

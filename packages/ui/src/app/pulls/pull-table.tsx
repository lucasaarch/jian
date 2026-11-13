'use client';

import { ArrowRight, GitPullRequest, GitPullRequestDraft, MessageSquare, Zap } from 'lucide-react';
import { Action, HoverTip, StatusPill } from '../../kit';
import type { GitHubPullRow } from '../../lib/api';
import { ago } from '../../lib/format';
import { checksPill, decisionPill, mergePill, pullKey } from './cells';

type GitHubPullReviewer = GitHubPullRow['reviewers'][number];
type ReviewerState = GitHubPullReviewer['state'];

const since = (value: string) => {
  const when = ago(value);
  return when === 'now' ? 'just now' : `${when} ago`;
};

// The outer cells sit further in, clear of the table's rounded corners.
const edges = 'px-3 first:pl-4 last:pr-4';
const head = `${edges} py-2.5 text-left text-[11px] font-medium tracking-wide text-muted uppercase`;
const cell = `${edges} py-3 align-middle`;

/** The open pull requests, one row each, in the order GitHub last saw them change. */
export function PullTable({
  pulls,
  starting,
  review,
  openChat,
}: {
  pulls: GitHubPullRow[];
  /** The row whose review is being started, which waits on its button. */
  starting: string | undefined;
  review: (pull: GitHubPullRow) => void;
  openChat: (review: NonNullable<GitHubPullRow['review']>) => void;
}) {
  return (
    <table className="w-full table-fixed border-collapse text-[13px]">
      <thead className="border-b border-line">
        <tr>
          <th className={`${head} w-24 phone:w-20`}>ID</th>
          <th className={head}>Title</th>
          <th className={`${head} w-28 phone:hidden`}>Reviewers</th>
          <th className={`${head} w-32 phone:hidden`}>Checks</th>
          <th className={`${head} w-28 phone:hidden`}>Merge</th>
          <th className={`${head} w-24 phone:hidden`}>Updated</th>
          <th className={`${head} w-36 text-right`}>
            <span className="sr-only">Agent review</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {pulls.map((pull) => (
          <PullRow
            key={pullKey(pull)}
            pull={pull}
            starting={starting === pullKey(pull)}
            review={() => review(pull)}
            openChat={openChat}
          />
        ))}
      </tbody>
    </table>
  );
}

function PullRow({
  pull,
  starting,
  review,
  openChat,
}: {
  pull: GitHubPullRow;
  starting: boolean;
  review: () => void;
  openChat: (review: NonNullable<GitHubPullRow['review']>) => void;
}) {
  const checks = checksPill(pull.checks);
  const merge = mergePill(pull);
  const decision = decisionPill(pull.reviewDecision);
  const Icon = pull.draft ? GitPullRequestDraft : GitPullRequest;

  return (
    <tr className="border-b border-line/60 transition-colors last:border-b-0 hover:bg-glass-hover">
      <td className={`${cell} font-mono text-xs text-muted`}>
        <span className="inline-flex items-center gap-1.5">
          <Icon size={14} className={pull.draft ? 'text-muted' : 'text-good'} aria-hidden="true" />#
          {pull.number}
        </span>
      </td>
      <td className={cell}>
        <a
          href={pull.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-medium text-ink hover:underline"
        >
          {pull.title}
        </a>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {pull.author && <span className="truncate">{pull.author.login}</span>}
          <span className="truncate">{pull.repo}</span>
          {decision && <StatusPill tone={decision.tone}>{decision.text}</StatusPill>}
          {pull.labels.slice(0, 3).map((label) => (
            <StatusPill key={label.name}>{label.name}</StatusPill>
          ))}
        </div>
      </td>
      <td className={`${cell} phone:hidden`}>
        <Reviewers reviewers={pull.reviewers} />
      </td>
      <td className={`${cell} phone:hidden`}>
        {checks ? <StatusPill tone={checks.tone}>{checks.text}</StatusPill> : <Dash />}
      </td>
      <td className={`${cell} phone:hidden`}>
        <StatusPill tone={merge.tone}>{merge.text}</StatusPill>
      </td>
      <td className={`${cell} text-xs text-muted phone:hidden`}>
        <time dateTime={pull.updatedAt}>{ago(pull.updatedAt)}</time>
      </td>
      <td className={`${cell} text-right`}>
        <span className="inline-flex items-center justify-end gap-1">
          {pull.review && (
            <HoverTip
              tip={`${pull.review.trigger === 'auto' ? 'Reviewed automatically' : 'Reviewed'} ${since(pull.review.createdAt)}. Open the chat.`}
            >
              <Action
                tone="quiet"
                size="small"
                aria-label="Open the review chat"
                onClick={() => pull.review && openChat(pull.review)}
              >
                {pull.review.trigger === 'auto' ? (
                  <Zap size={13} aria-hidden="true" />
                ) : (
                  <MessageSquare size={13} aria-hidden="true" />
                )}
              </Action>
            </HoverTip>
          )}
          <Action tone="outline" size="small" busy={starting} onClick={review}>
            Review
            <ArrowRight size={13} aria-hidden="true" />
          </Action>
        </span>
      </td>
    </tr>
  );
}

const REVIEWER_TONES: Record<ReviewerState, string> = {
  requested: 'ring-line',
  approved: 'ring-good',
  changes_requested: 'ring-bad',
  commented: 'ring-muted',
  dismissed: 'ring-line',
  pending: 'ring-warn',
};

const REVIEWER_STATES: Record<ReviewerState, string> = {
  requested: 'asked to review',
  approved: 'approved',
  changes_requested: 'requested changes',
  commented: 'commented',
  dismissed: 'review dismissed',
  pending: 'review pending',
};

/**
 * Initials, not avatars: a picture would be fetched from GitHub's servers, which the panel's
 * content policy keeps out. The ring says how each one stands.
 */
function Reviewers({ reviewers }: { reviewers: GitHubPullReviewer[] }) {
  if (!reviewers.length) return <Dash />;
  const shown = reviewers.slice(0, 3);
  return (
    <span className="inline-flex items-center gap-1">
      {shown.map((reviewer) => (
        <HoverTip
          key={reviewer.login}
          tip={`${reviewer.login}, ${REVIEWER_STATES[reviewer.state]}`}
        >
          <span
            className={`grid size-6 place-items-center rounded-full bg-glass-press text-[10px] font-semibold text-ink uppercase ring-2 ${REVIEWER_TONES[reviewer.state]}`}
          >
            {reviewer.login.slice(0, 2)}
          </span>
        </HoverTip>
      ))}
      {reviewers.length > shown.length && (
        <span className="text-xs text-muted">+{reviewers.length - shown.length}</span>
      )}
    </span>
  );
}

const Dash = () => <span className="text-muted">—</span>;

'use client';

import { ArrowRight, GitPullRequest, GitPullRequestDraft, MessageSquare, Zap } from 'lucide-react';
import { Action, HoverTip, iconButton, StatusPill } from '../../kit';
import type { GitHubPullRow } from '../../lib/api';
import { ago } from '../../lib/format';
import { checksPill, decisionPill, mergePill, pullKey } from './cells';

type GitHubPullReviewer = GitHubPullRow['reviewers'][number];
type ReviewerState = GitHubPullReviewer['state'];

const since = (value: string) => {
  const when = ago(value);
  return when === 'now' ? 'just now' : `${when} ago`;
};

// The table lies on the page, edge to edge: its outer cells keep the page's own margin, so the
// rows line up with the filters above them.
const edges = 'px-3 first:pl-5 last:pr-5 phone:first:pl-3 phone:last:pr-3';
const head = `${edges} py-2.5 text-left text-[11px] font-medium tracking-wide text-muted uppercase`;
const cell = `${edges} py-3 align-middle`;

/*
 * The table goes by its own width, which the Inspector beside it can halve, not the window's:
 * the wrapper holding it is the container. Every fixed column together is 44rem, so past each
 * width one goes, the least needed first, and the title keeps its room. Checks and merge then
 * move under the title.
 */
const reviewersCol = '@max-[56rem]:hidden';
const updatedCol = '@max-[50rem]:hidden';
const mergeCol = '@max-[44rem]:hidden';
const checksCol = '@max-[38rem]:hidden';

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
          <th className={`${head} w-28 ${reviewersCol}`}>Reviewers</th>
          <th className={`${head} w-32 ${checksCol}`}>Checks</th>
          <th className={`${head} w-28 ${mergeCol}`}>Merge</th>
          <th className={`${head} w-24 ${updatedCol}`}>Updated</th>
          <th className={`${head} w-40 text-right`}>
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
          {checks && (
            <span className="hidden @max-[38rem]:inline-flex">
              <StatusPill tone={checks.tone}>{checks.text}</StatusPill>
            </span>
          )}
          <span className="hidden @max-[44rem]:inline-flex">
            <StatusPill tone={merge.tone}>{merge.text}</StatusPill>
          </span>
          {decision && <StatusPill tone={decision.tone}>{decision.text}</StatusPill>}
          {pull.labels.slice(0, 3).map((label) => (
            <StatusPill key={label.name}>{label.name}</StatusPill>
          ))}
        </div>
      </td>
      <td className={`${cell} ${reviewersCol}`}>
        <Reviewers reviewers={pull.reviewers} />
      </td>
      <td className={`${cell} ${checksCol}`}>
        {checks ? <StatusPill tone={checks.tone}>{checks.text}</StatusPill> : <Dash />}
      </td>
      <td className={`${cell} ${mergeCol}`}>
        <StatusPill tone={merge.tone}>{merge.text}</StatusPill>
      </td>
      <td className={`${cell} text-xs text-muted ${updatedCol}`}>
        <time dateTime={pull.updatedAt}>{ago(pull.updatedAt)}</time>
      </td>
      <td className={`${cell} text-right`}>
        <span className="inline-flex items-center justify-end gap-1">
          {/* The review's chat holds a place of its own, there or not, so every Review button
              ends and starts on the same line down the table. */}
          {pull.review ? (
            <HoverTip
              tip={`${pull.review.trigger === 'auto' ? 'Reviewed automatically' : 'Reviewed'} ${since(pull.review.createdAt)}. Open the chat.`}
            >
              <button
                type="button"
                className={iconButton}
                aria-label="Open the review chat"
                onClick={() => pull.review && openChat(pull.review)}
              >
                {pull.review.trigger === 'auto' ? (
                  <Zap size={14} aria-hidden="true" />
                ) : (
                  <MessageSquare size={14} aria-hidden="true" />
                )}
              </button>
            </HoverTip>
          ) : (
            <span className="size-7 shrink-0" aria-hidden="true" />
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

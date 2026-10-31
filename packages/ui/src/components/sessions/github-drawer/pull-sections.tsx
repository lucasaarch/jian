'use client';

import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  type LucideIcon,
  MessageCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { GitHubPull } from '../../../lib/api';
import { date } from '../../../lib/format';
import { FileDiff } from '../code-change';
import { CheckMark, type CheckState, LinkLine, Quiet } from './parts';

/** Diffs open at once when a pull request touches this many files or fewer. */
const OPEN_FILES = 3;

type Run = GitHubPull['checks']['runs'][number];

function checkState(check: Run): CheckState {
  if (check.status !== 'completed') return 'pending';
  return ['success', 'neutral', 'skipped'].includes(check.conclusion ?? '') ? 'passing' : 'failing';
}

/** Seconds between two timestamps, read as a person says it: 3m 12s. */
function duration(from?: string, to?: string) {
  if (!from || !to) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);

  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How the checks went as a whole, and how many of them passed. */
export function checksStanding(runs: Run[]) {
  const passed = runs.filter((check) => checkState(check) === 'passing').length;
  const failed = runs.filter((check) => checkState(check) === 'failing').length;
  const state: CheckState = failed
    ? 'failing'
    : runs.some((check) => checkState(check) === 'pending')
      ? 'pending'
      : 'passing';
  return { passed, failed, pending: runs.length - passed - failed, state };
}

const standing: Record<CheckState, number> = { failing: 0, pending: 1, passing: 2 };

/** A line under a tab's name: what the tab holds, counted. */
function PanelHead({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">{children}</p>
  );
}

/** The checks on the head commit, what needs looking at first: how each went, and how long it took. */
export function Checks({ runs }: { runs: Run[] }) {
  const { passed, failed, pending } = checksStanding(runs);
  const ordered = [...runs].sort((a, b) => standing[checkState(a)] - standing[checkState(b)]);

  return (
    <div className="grid gap-3 px-5 py-4">
      {runs.length > 0 && (
        <PanelHead>
          <span className="text-good">{passed} passed</span>
          {failed > 0 && <span className="text-bad">{failed} failed</span>}
          {pending > 0 && <span className="text-warn">{pending} running</span>}
        </PanelHead>
      )}
      {runs.length ? (
        <ul className="grid gap-0.5">
          {ordered.map((check) => {
            const took = duration(check.startedAt, check.completedAt);

            return (
              <li key={check.name}>
                <LinkLine href={check.url}>
                  <CheckMark state={checkState(check)} />
                  <span className="min-w-0 truncate text-ink">{check.name}</span>
                  <span className="ml-auto shrink-0 text-xs capitalize text-muted">
                    {(check.status === 'completed'
                      ? (check.conclusion ?? 'completed')
                      : check.status
                    ).replace(/_/g, ' ')}
                    {took ? ` · ${took}` : ''}
                  </span>
                </LinkLine>
              </li>
            );
          })}
        </ul>
      ) : (
        <Quiet>No checks reported for this commit.</Quiet>
      )}
    </div>
  );
}

/** How much of what changed was added and how much removed, at a glance. */
export function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  return (
    <span
      aria-hidden="true"
      className="flex h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-ink/8"
    >
      {total > 0 && (
        <>
          <span className="bg-good" style={{ width: `${(additions / total) * 100}%` }} />
          <span className="bg-bad" style={{ width: `${(deletions / total) * 100}%` }} />
        </>
      )}
    </span>
  );
}

/** What the pull request changes: the lines it adds and removes, and each file's diff. */
export function Changes({ pull }: { pull: GitHubPull }) {
  return (
    <div className="grid gap-3 px-5 py-4">
      <PanelHead>
        <span>
          {pull.changedFiles} {pull.changedFiles === 1 ? 'file' : 'files'}
        </span>
        <span className="flex gap-2 font-mono">
          <span className="text-good">+{pull.additions}</span>
          <span className="text-bad">−{pull.deletions}</span>
        </span>
        <ChangeBar additions={pull.additions} deletions={pull.deletions} />
      </PanelHead>
      <div className="code-changes mb-0">
        {pull.files.map((file) =>
          file.diff ? (
            <FileDiff key={file.path} diff={file.diff} open={pull.files.length <= OPEN_FILES} />
          ) : (
            <p
              key={file.path}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-glass-edge px-3 py-2 font-mono text-[12.5px]"
            >
              <span className="min-w-0 truncate">{file.path}</span>
              <span className="ml-auto shrink-0 font-sans text-xs text-muted">
                No preview: binary or too large
              </span>
            </p>
          ),
        )}
      </div>
      {pull.filesTruncated && (
        <Quiet>Only the first {pull.files.length} files are shown here.</Quiet>
      )}
    </div>
  );
}

type Review = GitHubPull['reviews']['latest'][number];

const verdicts: Record<Review['state'], { name: string; colour: string; Mark: LucideIcon }> = {
  approved: { name: 'Approved', colour: 'text-good', Mark: CircleCheck },
  changes_requested: { name: 'Changes requested', colour: 'text-bad', Mark: CircleX },
  commented: { name: 'Commented', colour: 'text-muted', Mark: MessageCircle },
  dismissed: { name: 'Dismissed', colour: 'text-muted', Mark: CircleSlash },
  pending: { name: 'Pending', colour: 'text-warn', Mark: CircleDashed },
};

/** Each reviewer's latest word: their verdict, who, when; it opens where it was written. */
export function Reviews({ reviews }: { reviews: Review[] }) {
  return (
    <div className="grid gap-3 px-5 py-4">
      {reviews.length ? (
        <ul className="grid gap-0.5">
          {reviews.map((review) => {
            const { name, colour, Mark } = verdicts[review.state];

            return (
              <li key={review.reviewer.login}>
                <LinkLine href={review.url}>
                  <Mark size={14} aria-hidden="true" className={`shrink-0 ${colour}`} />
                  <span className="min-w-0 truncate font-medium text-ink">
                    {review.reviewer.login}
                  </span>
                  <span className={`shrink-0 text-xs ${colour}`}>{name}</span>
                  {review.submittedAt && (
                    <time className="ml-auto shrink-0 text-xs text-muted">
                      {date(review.submittedAt)}
                    </time>
                  )}
                </LinkLine>
              </li>
            );
          })}
        </ul>
      ) : (
        <Quiet>No reviews yet.</Quiet>
      )}
    </div>
  );
}

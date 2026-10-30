'use client';

import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  type LucideIcon,
  MessageCircle,
} from 'lucide-react';
import type { GitHubPull } from '../../../lib/api';
import { date } from '../../../lib/format';
import { FileDiff } from '../code-change';
import { CheckMark, type CheckState, LinkLine, Quiet, Section } from './parts';

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

/** The checks on the head commit, a line each: how it went, and how long it took. */
export function Checks({ runs }: { runs: Run[] }) {
  const passed = runs.filter((check) => checkState(check) === 'passing').length;
  const overall: CheckState = runs.some((check) => checkState(check) === 'failing')
    ? 'failing'
    : runs.some((check) => checkState(check) === 'pending')
      ? 'pending'
      : 'passing';

  return (
    <Section
      title="Checks"
      count={
        runs.length > 0 && (
          <>
            <CheckMark state={overall} size={13} />
            {passed}/{runs.length}
          </>
        )
      }
    >
      {runs.length ? (
        <ul className="grid gap-0.5">
          {runs.map((check) => {
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
    </Section>
  );
}

/** What the pull request changes: the lines it adds and removes, and each file's diff. */
export function Changes({ pull }: { pull: GitHubPull }) {
  return (
    <Section
      title="Changes"
      count={`${pull.changedFiles} ${pull.changedFiles === 1 ? 'file' : 'files'}`}
    >
      <p className="flex gap-2 font-mono text-xs">
        <span className="text-good">+{pull.additions}</span>
        <span className="text-bad">−{pull.deletions}</span>
      </p>
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
    </Section>
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
    <Section title="Reviews" count={reviews.length}>
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
    </Section>
  );
}

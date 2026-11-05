'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Copy, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Action, Segmented } from '../../../kit';
import type { GatewayApi, GitHubMergeMethod, GitHubPull } from '../../../lib/api';
import { date } from '../../../lib/format';
import { keys } from '../../../lib/query/keys';
import { FileFilter, WrapSwitch } from '../diff-controls';
import { barButton, InspectorBody } from '../inspector';
import { MergeButton, MergeConfirm } from './merge';
import { CheckMark, Person, StatePill, Written } from './parts';
import { Changes, Checks, checksStanding, Reviews } from './pull-sections';

export type Pull = Pick<GitHubPull, 'owner' | 'repo' | 'number'>;
type PullApi = Pick<
  GatewayApi,
  'githubPullFile' | 'markGithubPullReady' | 'mergeGithubPull' | 'updateGithubPullBranch'
>;

const mergeable: Record<GitHubPull['mergeable'], { note: string; colour: string }> = {
  clean: { note: 'Ready to merge.', colour: 'text-good' },
  conflicts: { note: 'This branch has conflicts with the base branch.', colour: 'text-bad' },
  blocked: {
    note: 'Merging is blocked by the repository’s rules or pending reviews.',
    colour: 'text-warn',
  },
  behind: { note: 'This branch is behind the base branch.', colour: 'text-warn' },
  unknown: { note: 'Checking whether it can merge…', colour: 'text-muted' },
};

type PullTab = 'changes' | 'description' | 'checks' | 'reviews';
/** The tab each pull request was left on, for as long as the panel is open. */
const lastTab = new Map<string, PullTab>();

const branch =
  'min-w-0 truncate rounded-md bg-ink/6 px-1.5 py-0.5 font-mono text-[11.5px] text-ink';

/**
 * What goes in the Inspector's top line for a pull request: where it stands, and from which branch
 * into which. Only what is in the line changes as it loads, so its close keeps the keyboard.
 */
export function PullBar({ pull }: { pull: GitHubPull }) {
  return (
    <>
      <StatePill state={pull.state} draft={pull.draft} />
      <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted">
        <code className={branch}>{pull.head.ref}</code>
        <ArrowRight size={12} aria-hidden="true" className="shrink-0" />
        <span className="sr-only">into</span>
        <code className={`${branch} shrink-0`}>{pull.base.ref}</code>
      </p>
    </>
  );
}

/** What the checks tab says of them, so where they stand reads without opening it. */
const checksNames = {
  passing: 'All checks passed',
  failing: 'Checks failing',
  pending: 'Checks running',
} as const;

/**
 * A pull request: where it stands and its branches in one line, its title, whether it can merge
 * and what to do about it, then its changes, description, checks and reviews. Its head is kept
 * short, since everything it takes comes off the diffs under it. A branch in conflict offers the
 * agent's way to settle it in the place of merging and of the line saying so.
 */
export function PullView({
  api,
  pull,
  url,
  wrap,
  setWrap,
  profileId,
  merges,
  fixConflicts,
}: {
  api: PullApi;
  pull: GitHubPull;
  url: string;
  /** How the drawer's diffs read: it holds this, since it says so to all of them. */
  wrap: boolean;
  setWrap: (wrap: boolean) => void;
  profileId: string;
  /** The panel answers this chat itself, so it merges from here. */
  merges: boolean;
  fixConflicts?: (pull: Pull) => Promise<unknown>;
}) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState<GitHubMergeMethod>();
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [readying, setReadying] = useState(false);
  const itemId = `${pull.owner}/${pull.repo}#${pull.number}`;
  const [tab, setTabState] = useState<PullTab>(lastTab.get(itemId) ?? 'changes');
  const [filter, setFilter] = useState('');
  const setTab = (next: PullTab) => {
    lastTab.set(itemId, next);
    setTabState(next);
  };
  const where = `${pull.owner}/${pull.repo} #${pull.number}`;
  const words = filter.trim().toLowerCase();
  const filtering = Boolean(words);
  const shownFiles = words
    ? pull.files.filter((file) => file.path.toLowerCase().includes(words))
    : pull.files;
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      toast.error('The link could not be copied.');
    }
  };
  const checks = checksStanding(pull.checks.runs);
  const reviews = pull.reviews;
  const open = pull.state === 'open';
  const behind = open && pull.mergeable === 'behind';
  const fixable = open && pull.mergeable === 'conflicts' && Boolean(fixConflicts);
  const readyForReview = open && pull.draft;
  const merging = open && !pull.draft && merges && pull.mergeable !== 'conflicts';
  const state = pull.draft
    ? { note: 'A draft does not merge until it is marked ready.', colour: 'text-muted' }
    : mergeable[pull.mergeable];

  const merge = async (method: GitHubMergeMethod) => {
    setBusy(true);
    const key = keys.githubItem('pull', pull.owner, pull.repo, pull.number);
    try {
      const merged = await api.mergeGithubPull(pull.owner, pull.repo, pull.number, {
        method,
        expectedHeadSha: pull.head.sha,
        profileId,
      });
      toast.success(merged.message);
      // Merged at once, in the drawer and in every reference to it. Not read again: GitHub's
      // reads can still say open for a moment, and a merge never comes undone.
      client.setQueryData<GitHubPull>(key, (known) =>
        known ? { ...known, state: 'merged' } : known,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'GitHub did not merge it.');
      // Refused: the head moved or a rule stood in the way, so read where it stands now.
      await client.invalidateQueries({ queryKey: key });
    } finally {
      setBusy(false);
      setConfirming(undefined);
    }
  };

  const updateBranch = async () => {
    setUpdating(true);
    const key = keys.githubItem('pull', pull.owner, pull.repo, pull.number);
    try {
      const result = await api.updateGithubPullBranch(
        pull.owner,
        pull.repo,
        pull.number,
        pull.head.sha,
      );
      toast.success(result.message);
      await client.invalidateQueries({ queryKey: key });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'GitHub could not update the branch.');
      await client.invalidateQueries({ queryKey: key });
    } finally {
      setUpdating(false);
    }
  };

  const markReady = async () => {
    setReadying(true);
    const key = keys.githubItem('pull', pull.owner, pull.repo, pull.number);
    try {
      const result = await api.markGithubPullReady(
        pull.owner,
        pull.repo,
        pull.number,
        pull.head.sha,
      );
      toast.success(result.message);
      client.setQueryData<GitHubPull>(key, (known) => (known ? { ...known, draft: false } : known));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'GitHub could not mark it ready.');
      await client.invalidateQueries({ queryKey: key });
    } finally {
      setReadying(false);
    }
  };

  const fix = async () => {
    if (!fixConflicts) return;
    setFixing(true);
    try {
      await fixConflicts(pull);
      toast.success('The agent is resolving the conflicts.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The agent could not be asked.');
    } finally {
      setFixing(false);
    }
  };

  return (
    <>
      <div className="shrink-0">
        <div className="grid gap-1.5 px-(--inspector-inset) pb-1.5">
          <div className="flex min-w-0 items-start gap-1">
            <h2 className="min-w-0 text-[15px] leading-snug font-semibold tracking-tight text-ink">
              {pull.title}{' '}
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                title={where}
                className="font-normal text-muted transition-colors hover:text-ink"
              >
                #{pull.number}
              </a>
            </h2>
            <button
              type="button"
              aria-label="Copy link"
              className={`${barButton} -mt-1`}
              onClick={() => void copyLink()}
            >
              <Copy size={13} aria-hidden="true" />
            </button>
          </div>
          {open && (
            <div className="grid gap-2.5">
              {!fixable && !behind && <p className={`text-xs ${state.colour}`}>{state.note}</p>}
              {(fixable || merging || behind || readyForReview) && (
                <div className="flex flex-wrap gap-2">
                  {fixable ? (
                    <Action tone="outline" size="small" busy={fixing} onClick={() => void fix()}>
                      {!fixing && <Sparkles size={13} aria-hidden="true" />}
                      Fix merge conflicts
                    </Action>
                  ) : behind ? (
                    <Action
                      tone="outline"
                      size="small"
                      busy={updating}
                      onClick={() => void updateBranch()}
                    >
                      {!updating && <RefreshCw size={13} aria-hidden="true" />}
                      Update branch
                    </Action>
                  ) : (
                    merging && <MergeButton pull={pull} merge={setConfirming} />
                  )}
                  {readyForReview && (
                    <Action
                      tone="outline"
                      size="small"
                      busy={readying}
                      onClick={() => void markReady()}
                    >
                      {!readying && <Check size={13} aria-hidden="true" />}
                      Mark as Ready
                    </Action>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="overflow-x-auto border-b border-glass-edge px-(--inspector-inset) pb-1.5">
          <Segmented
            flat
            label="Pull request"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'changes', label: 'Changes', count: pull.changedFiles },
              { value: 'description', label: 'Description' },
              pull.checks.runs.length
                ? {
                    value: 'checks',
                    label: checksNames[checks.state],
                    icon: <CheckMark state={checks.state} size={13} />,
                    count: `${checks.passed}/${pull.checks.runs.length}`,
                  }
                : { value: 'checks', label: 'Checks' },
              { value: 'reviews', label: 'Reviews', count: reviews.latest.length },
            ]}
          />
        </div>
      </div>
      {tab === 'changes' && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-glass-edge px-(--inspector-inset) py-1.5">
          <span className="flex shrink-0 gap-1.5 text-xs text-muted">
            {filtering ? `${shownFiles.length} of ` : ''}
            {pull.changedFiles} {pull.changedFiles === 1 ? 'file' : 'files'}
            <span className="font-mono text-good">+{pull.additions}</span>
            <span className="font-mono text-bad">−{pull.deletions}</span>
          </span>
          <FileFilter value={filter} onChange={setFilter} className="min-w-32" />
          <WrapSwitch wrap={wrap} setWrap={setWrap} />
        </div>
      )}
      {/* One tab at a time is drawn: a large diff costs nothing until it is asked for. */}
      <InspectorBody key={tab}>
        {tab === 'changes' && (
          <Changes
            pull={pull}
            files={shownFiles}
            filter={filter.trim()}
            reviewScope={`pull:${itemId}`}
            readLines={(path) =>
              api
                .githubPullFile(pull.owner, pull.repo, pull.number, path, pull.head.sha)
                .then((file) => file.lines)
            }
          />
        )}
        {tab === 'description' && (
          <section aria-label="Description" className="grid gap-2 px-(--inspector-inset) py-3">
            <p className="text-xs text-muted">
              <Person login={pull.author?.login} /> · {date(pull.createdAt)}
            </p>
            <Written text={pull.body} none="No description." />
          </section>
        )}
        {tab === 'checks' && <Checks runs={pull.checks.runs} />}
        {tab === 'reviews' && <Reviews reviews={reviews.latest} />}
      </InspectorBody>
      <MergeConfirm
        pull={pull}
        method={confirming}
        busy={busy}
        close={() => setConfirming(undefined)}
        merge={(method) => void merge(method)}
      />
    </>
  );
}

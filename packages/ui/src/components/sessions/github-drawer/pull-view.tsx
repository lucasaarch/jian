'use client';

import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Sparkles } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { Action, Segmented } from '../../../kit';
import type { GatewayApi, GitHubMergeMethod, GitHubPull } from '../../../lib/api';
import { keys } from '../../../lib/query/keys';
import { InspectorBody, InspectorHeader } from '../inspector';
import { MergeButton, MergeConfirm } from './merge';
import { Byline, CheckMark, Section, Written } from './parts';
import { ChangeBar, Changes, Checks, checksStanding, Reviews } from './pull-sections';

export type Pull = Pick<GitHubPull, 'owner' | 'repo' | 'number'>;
type MergeApi = Pick<GatewayApi, 'mergeGithubPull' | 'updateGithubPullBranch'>;

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

type PullTab = 'overview' | 'checks' | 'changes' | 'reviews';
/** The tab each pull request was left on, for as long as the panel is open. */
const lastTab = new Map<string, PullTab>();

/** A figure of the overview, which is also the way to the tab with all of it. */
function Glance({ label, go, children }: { label: string; go: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={go}
      className="grid min-w-0 gap-1.5 rounded-xl border border-glass-edge p-3 text-left transition-colors hover:bg-glass-hover"
    >
      <span className="text-xs text-muted">{label}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium text-ink">
        {children}
      </span>
    </button>
  );
}

const branch =
  'min-w-0 truncate rounded-md bg-ink/6 px-1.5 py-0.5 font-mono text-[11.5px] text-ink';

/**
 * A pull request: where it stands, its branches, whether it can merge and what to do about it,
 * then its description, checks, changes and reviews. A branch in conflict offers the agent's way
 * to settle it in the place of merging and of the line saying so.
 */
export function PullView({
  api,
  pull,
  profileId,
  merges,
  fixConflicts,
}: {
  api: MergeApi;
  pull: GitHubPull;
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
  const itemId = `${pull.owner}/${pull.repo}#${pull.number}`;
  const [tab, setTabState] = useState<PullTab>(lastTab.get(itemId) ?? 'overview');
  const setTab = (next: PullTab) => {
    lastTab.set(itemId, next);
    setTabState(next);
  };
  const checks = checksStanding(pull.checks.runs);
  const reviews = pull.reviews;
  const open = pull.state === 'open';
  const behind = open && pull.mergeable === 'behind';
  const fixable = open && pull.mergeable === 'conflicts' && Boolean(fixConflicts);
  const merging = open && merges && pull.mergeable !== 'conflicts';
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
      <InspectorHeader title={pull.title}>
        <Byline
          state={pull.state}
          draft={pull.draft}
          login={pull.author?.login}
          at={pull.createdAt}
        />
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <code className={branch}>{pull.base.ref}</code>
          <span aria-hidden="true">←</span>
          <span className="sr-only">from</span>
          <code className={branch}>{pull.head.ref}</code>
        </p>
        {open && !fixable && !behind && <p className={`text-xs ${state.colour}`}>{state.note}</p>}
        {(fixable || merging || behind) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
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
              <MergeButton pull={pull} merge={setConfirming} />
            )}
          </div>
        )}
      </InspectorHeader>
      <div className="shrink-0 border-b border-glass-edge px-5 py-2.5">
        <Segmented
          label="Pull request"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            {
              value: 'checks',
              label: pull.checks.runs.length
                ? `Checks ${checks.passed}/${pull.checks.runs.length}`
                : 'Checks',
            },
            { value: 'changes', label: `Changes ${pull.changedFiles}` },
            { value: 'reviews', label: `Reviews ${reviews.latest.length}` },
          ]}
        />
      </div>
      {/* One tab at a time is drawn: a large diff costs nothing until it is asked for. */}
      <InspectorBody key={tab}>
        {tab === 'overview' && (
          <>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2 px-5 pt-4 pb-4">
              <Glance label="Checks" go={() => setTab('checks')}>
                {pull.checks.runs.length ? (
                  <>
                    <CheckMark state={checks.state} size={13} />
                    {checks.passed}/{pull.checks.runs.length} passed
                  </>
                ) : (
                  'None reported'
                )}
              </Glance>
              <Glance label="Changes" go={() => setTab('changes')}>
                <span className="font-mono text-good">+{pull.additions}</span>
                <span className="font-mono text-bad">−{pull.deletions}</span>
                <ChangeBar additions={pull.additions} deletions={pull.deletions} />
              </Glance>
              <Glance label="Reviews" go={() => setTab('reviews')}>
                {reviews.approved || reviews.changesRequested
                  ? [
                      reviews.approved ? `${reviews.approved} approved` : '',
                      reviews.changesRequested ? `${reviews.changesRequested} changes` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : reviews.latest.length
                    ? `${reviews.latest.length} commented`
                    : 'None yet'}
              </Glance>
            </div>
            <Section title="Description">
              <Written text={pull.body} none="No description." />
            </Section>
          </>
        )}
        {tab === 'checks' && <Checks runs={pull.checks.runs} />}
        {tab === 'changes' && <Changes pull={pull} />}
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

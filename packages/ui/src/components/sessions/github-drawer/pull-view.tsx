'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Action } from '../../../kit';
import type { GatewayApi, GitHubMergeMethod, GitHubPull } from '../../../lib/api';
import { keys } from '../../../lib/query/keys';
import { InspectorBody, InspectorHeader } from '../inspector';
import { MergeButton, MergeConfirm } from './merge';
import { Byline, Section, Written } from './parts';
import { Changes, Checks, Reviews } from './pull-sections';

export type Pull = Pick<GitHubPull, 'owner' | 'repo' | 'number'>;
type MergeApi = Pick<GatewayApi, 'mergeGithubPull'>;

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
  const open = pull.state === 'open';
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
        {open && !fixable && <p className={`text-xs ${state.colour}`}>{state.note}</p>}
        {(fixable || merging) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {fixable ? (
              <Action tone="outline" size="small" busy={fixing} onClick={() => void fix()}>
                {!fixing && <Sparkles size={13} aria-hidden="true" />}
                Fix merge conflicts
              </Action>
            ) : (
              <MergeButton pull={pull} merge={setConfirming} />
            )}
          </div>
        )}
      </InspectorHeader>
      <InspectorBody>
        <Section title="Description">
          <Written text={pull.body} none="No description." />
        </Section>
        <Checks runs={pull.checks.runs} />
        <Changes pull={pull} />
        <Reviews reviews={pull.reviews.latest} />
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

'use client';

import { Popover } from '@base-ui/react/popover';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Action, ConfirmDialog, pillClass } from '../../kit';
import type { GatewayApi, SessionWorktree } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { useCrew } from '../../lib/stores/crew';

type WorktreesApi = Pick<
  GatewayApi,
  | 'sessionWorktrees'
  | 'mergeSessionWorktree'
  | 'updateSessionWorktree'
  | 'openWorktreePullRequest'
  | 'discardSessionWorktree'
>;

/** Where it stands against its base, in a line. A zero says nothing; a place out of reach says so. */
function standing({ ahead, behind, uncommitted }: SessionWorktree): string {
  if (ahead === null || behind === null || uncommitted === null) return 'Not reachable';
  const said = [
    ahead ? `${ahead} ahead` : '',
    behind ? `${behind} behind` : '',
    uncommitted ? `${uncommitted} uncommitted` : '',
  ].filter(Boolean);
  return said.length ? said.join(' · ') : 'Up to date';
}

/**
 * What discarding loses, said plainly: the folder goes, and the branch stays with any commits of
 * its own. One with none is deleted, so there is nothing to say about it; one out of reach may
 * have some.
 */
function Loss({ worktree }: { worktree: SessionWorktree }) {
  const { uncommitted, branch, ahead } = worktree;
  const lost =
    uncommitted === null
      ? 'Any uncommitted files in it are lost.'
      : uncommitted === 0
        ? 'Its folder is removed.'
        : uncommitted === 1
          ? 'Its 1 uncommitted file is lost.'
          : `Its ${uncommitted} uncommitted files are lost.`;
  return (
    <>
      {lost}
      {ahead !== 0 && ` Its commits stay on ${branch}.`}
    </>
  );
}

function Row({
  worktree,
  busy,
  ask,
  api,
  profileId,
  sessionId,
  discard,
}: {
  worktree: SessionWorktree;
  /** The agent has a turn open: removing the folder under it is refused. */
  busy: boolean;
  /** Runs a call, tells the owner how it went, and answers whether it went through. */
  ask: (call: () => Promise<unknown>, done: string) => Promise<boolean>;
  api: WorktreesApi;
  profileId: string;
  sessionId: string;
  discard: () => void;
}) {
  const [working, setWorking] = useState(false);
  const { name, branch, base } = worktree;
  const run = async (call: () => Promise<unknown>, done: string) => {
    setWorking(true);
    try {
      return await ask(call, done);
    } finally {
      setWorking(false);
    }
  };

  return (
    <li className="session-worktree">
      <span className="session-worktree-text">
        <span className="session-worktree-name">{name}</span>
        <span className="session-worktree-meta">
          {branch} → {base}
        </span>
        <span className="session-worktree-meta">{standing(worktree)}</span>
        {/* A disabled button says nothing on hover or on a phone, so the row says why. */}
        {busy && (
          <span className="session-worktree-meta">Discard once the agent has finished.</span>
        )}
      </span>
      <span className="session-worktree-actions">
        <Action
          tone="quiet"
          size="small"
          title={`Merge into ${base}`}
          disabled={working}
          onClick={() =>
            run(
              () => api.mergeSessionWorktree(profileId, sessionId, name),
              `The agent is merging ${name} into ${base}.`,
            )
          }
        >
          {`Merge into ${base}`}
        </Action>
        <Action
          tone="quiet"
          size="small"
          title={`Update from ${base}`}
          disabled={working}
          onClick={() =>
            run(
              () => api.updateSessionWorktree(profileId, sessionId, name, 'merge'),
              `The agent is updating ${name} from ${base}.`,
            )
          }
        >
          {`Update from ${base}`}
        </Action>
        {worktree.pullRequest && (
          <Action
            tone="quiet"
            size="small"
            disabled={working}
            onClick={() =>
              run(
                () => api.openWorktreePullRequest(profileId, sessionId, name),
                `The agent is opening a pull request for ${name}.`,
              )
            }
          >
            Open pull request
          </Action>
        )}
        <Action tone="danger" size="small" disabled={busy || working} onClick={discard}>
          Discard
        </Action>
      </span>
    </li>
  );
}

/**
 * Sets the Inspector's flag for the conversation in front. The flag is reset when the one left
 * is closed, so a switch between two conversations that both have a worktree sets it again: the
 * answer was cached and did not change, but the effect must still run for the new one.
 */
export function useChangesFlag(sessionId: string | undefined, has: boolean) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the conversation is what re-runs it.
  useEffect(() => {
    useCrew.setState({ worktrees: has });
    return () => useCrew.setState({ worktrees: false });
  }, [sessionId, has]);
}

/**
 * The conversation's worktrees as a badge beside its pull requests, with where each stands and
 * what the owner can do with it. Merge, update and pull request ask the agent, which does the
 * work, and steer into a turn already open; discard is the owner's own and waits for the turn to
 * end. A conversation with none, or a gateway too old to answer, leaves simply no badge.
 */
export function SessionWorktrees({
  api,
  profileId,
  sessionId,
  busy,
  onAction,
}: {
  api: WorktreesApi;
  profileId: string;
  sessionId: string;
  busy: boolean;
  /** An action went through: the conversation has something new to read. */
  onAction: () => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [discarding, setDiscarding] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const { data: worktrees = [] } = useQuery({
    queryKey: keys.sessionWorktrees(profileId, sessionId),
    queryFn: () => api.sessionWorktrees(profileId, sessionId),
  });

  if (!worktrees.length) return null;

  const ask = async (call: () => Promise<unknown>, done: string) => {
    try {
      await call();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The agent could not be asked.');
      return false;
    }
    toast.success(done);
    await client.invalidateQueries({ queryKey: keys.sessionWorktrees(profileId, sessionId) });
    onAction();
    return true;
  };
  const [first] = worktrees;
  const single = worktrees.length === 1 ? first : undefined;
  const label = single ? single.name : `${worktrees.length} worktrees`;

  const doomed = worktrees.find((item) => item.name === discarding);

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={`${pillClass()} session-badge-trigger`}
          aria-label={
            single ? `Worktree ${single.name}: show its actions` : `${label}: show their actions`
          }
        >
          <GitBranch size={12} aria-hidden="true" />
          {label}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            className="select-positioner"
            side="top"
            align="end"
            sideOffset={8}
            positionMethod="fixed"
            collisionBoundary={[]}
          >
            <Popover.Popup className="model-menu session-badge-popup session-pulls-popup">
              <Popover.Title className="session-badge-title">Worktrees</Popover.Title>
              <ul className="session-pulls" aria-label="Worktrees">
                {worktrees.map((worktree) => (
                  <Row
                    key={worktree.name}
                    worktree={worktree}
                    busy={busy}
                    ask={ask}
                    api={api}
                    profileId={profileId}
                    sessionId={sessionId}
                    discard={() => {
                      // The question stands outside the popover, which gives way to it.
                      setOpen(false);
                      setDiscarding(worktree.name);
                    }}
                  />
                ))}
              </ul>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {doomed && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setDiscarding(undefined);
          }}
          title={`Discard ${doomed.name}?`}
          action="Discard worktree"
          busy={removing}
          run={async () => {
            setRemoving(true);
            try {
              const gone = await ask(
                () => api.discardSessionWorktree(profileId, sessionId, doomed.name),
                `${doomed.name} was discarded.`,
              );
              if (gone) setDiscarding(undefined);
            } finally {
              setRemoving(false);
            }
          }}
        >
          <Loss worktree={doomed} />
        </ConfirmDialog>
      )}
    </>
  );
}

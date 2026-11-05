'use client';

import { Popover } from '@base-ui/react/popover';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Action, ConfirmDialog, pillClass } from '../../kit';
import type { GatewayApi, SessionWorktree } from '../../lib/api';
import { keys } from '../../lib/query/keys';

type WorktreesApi = Pick<
  GatewayApi,
  | 'sessionWorktrees'
  | 'mergeSessionWorktree'
  | 'updateSessionWorktree'
  | 'openWorktreePullRequest'
  | 'discardSessionWorktree'
>;

/** Where it stands against its base, in a line. A zero says nothing; a place out of reach says so. */
export function standing({ ahead, behind, uncommitted }: SessionWorktree): string {
  if (ahead === null || behind === null || uncommitted === null) return 'Not reachable';
  const said = [
    ahead ? `${ahead} ahead` : '',
    behind ? `${behind} behind` : '',
    uncommitted ? `${uncommitted} uncommitted` : '',
  ].filter(Boolean);
  return said.length ? said.join(' · ') : 'Up to date';
}

/** What discarding loses, said plainly: the folder goes, the branch and its commits stay. */
function Loss({ worktree }: { worktree: SessionWorktree }) {
  const { uncommitted, branch } = worktree;
  const lost = uncommitted
    ? uncommitted === 1
      ? 'Its 1 uncommitted file is lost.'
      : `Its ${uncommitted} uncommitted files are lost.`
    : 'Its folder is removed.';
  return (
    <>
      {lost} Its commits stay on {branch}.
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
}: {
  worktree: SessionWorktree;
  /** The agent has a turn open: removing the folder under it is refused. */
  busy: boolean;
  /** Runs a call, tells the owner how it went, and answers whether it went through. */
  ask: (call: () => Promise<unknown>, done: string) => Promise<boolean>;
  api: WorktreesApi;
  profileId: string;
  sessionId: string;
}) {
  const [asking, setAsking] = useState(false);
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
      </span>
      <span className="session-worktree-actions">
        <Action
          tone="quiet"
          size="small"
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
        <Action
          tone="danger"
          size="small"
          disabled={busy || working}
          onClick={() => setAsking(true)}
        >
          Discard
        </Action>
      </span>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Discard ${name}?`}
        action="Discard worktree"
        busy={working}
        run={async () => {
          const gone = await run(
            () => api.discardSessionWorktree(profileId, sessionId, name),
            `${name} was discarded.`,
          );
          if (gone) setAsking(false);
        }}
      >
        <Loss worktree={worktree} />
      </ConfirmDialog>
    </li>
  );
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

  return (
    <Popover.Root>
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
                />
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

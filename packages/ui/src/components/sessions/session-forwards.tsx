'use client';

import { Popover } from '@base-ui/react/popover';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, X } from 'lucide-react';
import { iconButton, pillClass } from '../../kit';
import type { GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';

type ForwardsApi = Pick<GatewayApi, 'sessionForwards' | 'closeForward'>;

const standingOf = {
  waiting: 'Waiting for the computer',
  open: 'Open',
  failed: 'Failed',
} as const;

/**
 * The ports of the server the agent made reachable on a computer, as a badge above the composer.
 * Each row says where it is open and who holds it, opens the address in the owner's browser, and
 * has a button to stop it. The list follows the gateway's events, so there is nothing to refresh.
 * A gateway too old to answer leaves simply no badge.
 */
export function SessionForwards({
  api,
  profileId,
  sessionId,
}: {
  api: ForwardsApi;
  profileId: string;
  sessionId: string;
}) {
  const client = useQueryClient();
  const key = keys.sessionForwards(profileId, sessionId);
  const { data: forwards = [] } = useQuery({
    queryKey: key,
    queryFn: () => api.sessionForwards(profileId, sessionId),
  });
  const stop = useMutation({
    mutationFn: (forwardId: string) => api.closeForward(profileId, forwardId),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });

  if (!forwards.length) return null;

  const [first] = forwards;
  const label = forwards.length === 1 ? `:${first?.remotePort}` : `${forwards.length} ports`;

  return (
    <Popover.Root>
      <Popover.Trigger
        className={`${pillClass()} session-badge-trigger`}
        aria-label={`${label}: show the ports forwarded to a computer`}
      >
        <ArrowLeftRight size={12} aria-hidden="true" />
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
            <Popover.Title className="session-badge-title">Forwarded ports</Popover.Title>
            <ul className="session-pulls" aria-label="Forwarded ports">
              {forwards.map((forward) => {
                const url = `http://localhost:${forward.localPort}`;
                const text = (
                  <span className="session-pull-text">
                    <span className="session-pull-title">
                      {forward.status === 'open'
                        ? `localhost:${forward.localPort} ← server :${forward.remotePort}`
                        : `Server :${forward.remotePort}`}
                    </span>
                    <span className="session-pull-meta">
                      <span title={forward.error}>{standingOf[forward.status]}</span> ·{' '}
                      {forward.machineName}
                      {forward.error && <span className="sr-only">: {forward.error}</span>}
                    </span>
                  </span>
                );
                return (
                  <li key={forward.id} className="session-forward">
                    {forward.status === 'open' ? (
                      <a className="session-pull" href={url} target="_blank" rel="noreferrer">
                        {text}
                      </a>
                    ) : (
                      <div className="session-pull">{text}</div>
                    )}
                    <button
                      type="button"
                      className={iconButton}
                      aria-label={`Stop forwarding port ${forward.remotePort}`}
                      title="Stop forwarding"
                      disabled={stop.isPending}
                      onClick={() => stop.mutate(forward.id)}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

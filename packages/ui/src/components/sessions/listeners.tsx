'use client';

import { Popover } from '@base-ui/react/popover';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ear, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { StatusPill, type StatusTone } from '../../kit';
import type { GatewayApi, Subscription } from '../../lib/api';
import { date, LOCALE } from '../../lib/format';
import { keys } from '../../lib/query/keys';

function observationLabel(item: Subscription): string {
  const seen = item.lastObservation;
  if (!seen) return 'Waiting for first poll';
  if (seen.pullState === 'closed') return seen.merged ? 'Merged' : 'Closed';
  if (seen.checksCompleted) {
    const conclusion = seen.checkConclusion ?? 'completed';
    return conclusion === 'success' ? 'Checks green' : `Checks ${conclusion}`;
  }
  if (seen.pullState === 'open') return 'Open · checks pending';
  return 'Watching';
}

function observationTone(item: Subscription): StatusTone {
  const seen = item.lastObservation;
  if (!seen) return 'quiet';
  if (seen.pullState === 'closed') return seen.merged ? 'good' : 'quiet';
  if (seen.checksCompleted) {
    if (seen.checkConclusion === 'success') return 'good';
    if (seen.checkConclusion === 'failure' || seen.checkConclusion === 'timed_out') return 'bad';
    return 'warn';
  }
  return 'warn';
}

function watchedLabel(item: Subscription): string {
  const { owner, repo, pullNumber, checkName } = item.filter;
  const pull = pullNumber ? `#${pullNumber}` : 'repo events';
  const check = checkName ? ` · ${checkName}` : '';
  return `${owner}/${repo} ${pull}${check}`;
}

function shortWhen(value: string): string {
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return value;
  return moment.toDateString() === new Date().toDateString()
    ? moment.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
    : moment.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit' });
}

/**
 * The listeners watching something for this conversation, as a badge beside its objective. The
 * list opens from it: what each watches, where it stands, when it looks next and when it ends,
 * and a way to stop it.
 */
export function SessionListeners({
  api,
  profileId,
  sessionId,
  side = 'top',
}: {
  api: Pick<GatewayApi, 'subscriptions' | 'stopSubscription'>;
  profileId: string;
  sessionId: string;
  /** Above the composer at the bottom of the screen; below a header at the top. */
  side?: 'top' | 'bottom';
}) {
  const client = useQueryClient();
  const [stopping, setStopping] = useState<string>();
  // The agent's listeners, shared by every conversation; the stream reloads them as they change.
  // Without the list there is simply nothing to show.
  const { data: all = [] } = useQuery({
    queryKey: keys.subscriptions(profileId),
    queryFn: () => api.subscriptions(profileId),
  });
  const now = Date.now();
  const items = all.filter(
    (item) => item.sessionId === sessionId && item.enabled && Date.parse(item.expiresAt) > now,
  );

  if (!items.length) return null;

  const stop = async (item: Subscription) => {
    setStopping(item.id);
    try {
      await api.stopSubscription(profileId, item.id);
      // Stopping writes no event of its own, so the list is read again here.
      await client.invalidateQueries({ queryKey: keys.subscriptions(profileId) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The listener could not be stopped.');
    } finally {
      setStopping(undefined);
    }
  };
  const label = items.length === 1 ? 'Listening' : `Listening · ${items.length}`;

  return (
    <Popover.Root>
      <Popover.Trigger
        className="badge accent session-badge-trigger"
        aria-label={`${label}: show the listeners`}
      >
        <Ear size={12} aria-hidden="true" />
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="select-positioner"
          side={side}
          align="end"
          sideOffset={8}
          positionMethod="fixed"
          collisionBoundary={[]}
        >
          <Popover.Popup className="model-menu session-badge-popup">
            <Popover.Title className="session-badge-title">Active listeners</Popover.Title>
            <ul className="session-listeners" aria-label="Active listeners">
              {items.map((item) => (
                <li key={item.id}>
                  <div className="session-listener-text">
                    <span className="session-listener-name" title={item.instruction}>
                      {item.name}
                    </span>
                    <span className="session-listener-target">{watchedLabel(item)}</span>
                    <span className="session-listener-meta">
                      <StatusPill tone={observationTone(item)}>{observationLabel(item)}</StatusPill>
                      {item.nextPollAt ? (
                        <span title={date(item.nextPollAt)}>
                          Next poll {shortWhen(item.nextPollAt)}
                        </span>
                      ) : null}
                      <span title={date(item.expiresAt)}>Expires {shortWhen(item.expiresAt)}</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="session-listener-stop"
                    aria-label={`Stop ${item.name}`}
                    disabled={stopping === item.id}
                    onClick={() => void stop(item)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

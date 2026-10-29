'use client';

import { useQuery } from '@tanstack/react-query';
import { Ear } from 'lucide-react';
import { keys } from '@/lib/query/keys';
import type { GatewayApi, Subscription } from '../../lib/api';
import { date, LOCALE } from '../../lib/format';
import { Badge } from '../ui';

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

function observationTone(item: Subscription): 'good' | 'warn' | 'bad' | 'neutral' {
  const seen = item.lastObservation;
  if (!seen) return 'neutral';
  if (seen.pullState === 'closed') return seen.merged ? 'good' : 'neutral';
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
 * Active Listening rows for this conversation: what is watched, last status, next poll and
 * when the listener expires. Sits under the objective in the pane header.
 */
export function SessionListeners({
  api,
  profileId,
  sessionId,
}: {
  api: GatewayApi;
  profileId: string;
  sessionId: string;
}) {
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

  return (
    <ul className="session-listeners" aria-label="Active listeners">
      {items.map((item) => (
        <li key={item.id}>
          <Ear size={12} aria-hidden="true" />
          <span className="session-listener-name" title={item.instruction}>
            {item.name}
          </span>
          <span className="session-listener-target" title={watchedLabel(item)}>
            {watchedLabel(item)}
          </span>
          <Badge tone={observationTone(item)} dot={false}>
            {observationLabel(item)}
          </Badge>
          <span className="session-listener-meta">
            {item.nextPollAt ? (
              <span title={date(item.nextPollAt)}>Next poll {shortWhen(item.nextPollAt)}</span>
            ) : null}
            <span title={date(item.expiresAt)}>Expires {shortWhen(item.expiresAt)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

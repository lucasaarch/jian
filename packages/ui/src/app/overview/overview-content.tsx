'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, GraduationCap, MessageSquareText, MessagesSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CountUp, Spinner } from '../../components/ui';
import { Action, Segmented } from '../../kit';
import type { GatewayApi } from '../../lib/api';
import { subscribe } from '../../lib/events';
import { LOCALE } from '../../lib/format';
import { useAgent } from '../../lib/query/agent';
import { panelApi } from '../../lib/query/client';
import { keys } from '../../lib/query/keys';
import { Part, Tile, Tiles } from './figures';
import { duration } from './format';
import { ActivityHeatmap } from './heatmap';
import { ChannelCards, UsageSummary } from './usage';

/** The periods the usage is read over, in days; all time is ten years. */
const periods = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '3660', label: 'All time' },
];

/**
 * The stats of the open agent, read again when a turn moves: a run's usage is written at the
 * end of each step, so the numbers climb while the agent works. Reads are spaced, since several
 * events arrive together. Changing the period keeps the last numbers until the new ones land.
 */
function useStats(api: GatewayApi, profileId: string, days: number) {
  const client = useQueryClient();
  // A failure is shown with a button to try again, so the read is not retried behind it.
  const query = useQuery({
    queryKey: keys.stats(profileId, days),
    queryFn: () => api.stats(profileId, days),
    placeholderData: keepPreviousData,
    retry: false,
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const stop = subscribe((event) => {
      if (!event.type.startsWith('run.') && !event.type.startsWith('memory.')) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => void client.invalidateQueries({ queryKey: keys.stats(profileId, days) }),
        1500,
      );
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [client, profileId, days]);

  return { stats: query.data, failed: query.isError, retry: () => void query.refetch() };
}

/**
 * What the agent has done since it was made, its usage over a period, where its work came from
 * and when it was at work over the year. Nothing shows until the numbers do.
 */
export function OverviewContent({ api = panelApi() }: { api?: GatewayApi }) {
  const profile = useAgent();
  const [days, setDays] = useState('30');
  const { stats, failed, retry } = useStats(api, profile.id, Number(days));

  if (!stats) {
    return (
      <div className="grid place-items-center gap-3 py-16" role="status" aria-label="Overview">
        {failed ? (
          <>
            <p className="text-sm">The overview could not be read.</p>
            <Action tone="outline" size="small" onClick={retry}>
              Try again
            </Action>
          </>
        ) : (
          <Spinner size={22} />
        )}
      </div>
    );
  }

  return (
    <>
      <Part
        title="Since it was made"
        action={
          <span className="text-xs text-muted">
            {new Date(stats.since).toLocaleDateString(LOCALE, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
          </span>
        }
      >
        <Tiles>
          <Tile icon={<MessageSquareText size={16} />} label="Turns answered">
            <CountUp value={stats.totals.turns} />
          </Tile>
          <Tile icon={<Clock size={16} />} label="Time worked">
            <CountUp value={stats.totals.workedMs} format={duration} />
          </Tile>
          <Tile icon={<MessagesSquare size={16} />} label="Conversations">
            <CountUp value={stats.totals.conversations} />
          </Tile>
          <Tile icon={<GraduationCap size={16} />} label="Skills and memories kept">
            <CountUp value={stats.totals.skillsWritten + stats.totals.memories} />
          </Tile>
        </Tiles>
      </Part>
      <Part
        title="Usage"
        action={<Segmented label="Period" value={days} onChange={setDays} options={periods} />}
      >
        <UsageSummary stats={stats} />
      </Part>
      {stats.channels.length > 0 && (
        <Part title="Channels">
          <ChannelCards stats={stats} />
        </Part>
      )}
      <ActivityHeatmap profile={profile} api={api} />
    </>
  );
}

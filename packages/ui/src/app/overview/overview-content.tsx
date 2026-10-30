'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, GraduationCap, MessageSquareText, MessagesSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CountUp } from '../../components/ui';
import { Action, Segmented, Skeleton } from '../../kit';
import type { GatewayApi, ProfileStats } from '../../lib/api';
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
 * and when it was at work over the year. The numbers and the year are read apart, and each part
 * holds its shape until its own arrive.
 */
export function OverviewContent({ api = panelApi() }: { api?: GatewayApi }) {
  const profile = useAgent();
  const [days, setDays] = useState('30');
  const { stats, failed, retry } = useStats(api, profile.id, Number(days));

  return (
    <>
      <Figures stats={stats} failed={failed} retry={retry} days={days} onDays={setDays} />
      <ActivityHeatmap profile={profile} api={api} />
    </>
  );
}

/**
 * The Overview while the agent itself is still being read: the figures' shape, so the page that
 * follows lands on the same layout. The year is left out, as it needs the agent to be read.
 */
export function OverviewWaiting() {
  return <Figures days="30" />;
}

/**
 * The totals, the period's usage and the channels, or their shape while they are read. The
 * status sits outside the busy region: a reader holds back what a busy region says until it is
 * done, so inside it the loading would never be announced.
 */
function Figures({
  stats,
  failed = false,
  retry,
  days,
  onDays = () => {},
}: {
  stats?: ProfileStats;
  failed?: boolean;
  retry?: () => void;
  days: string;
  onDays?: (days: string) => void;
}) {
  return (
    <>
      <p role="status" className="sr-only">
        {stats || failed ? '' : 'Loading overview…'}
      </p>
      {failed && !stats ? (
        <div className="grid place-items-center gap-3 py-16">
          <p role="alert" className="text-sm">
            The overview could not be read.
          </p>
          <Action tone="outline" size="small" onClick={retry}>
            Try again
          </Action>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6" aria-busy={!stats}>
          <Part
            title="Since it was made"
            action={
              stats ? (
                <span className="text-xs text-muted">
                  {new Date(stats.since).toLocaleDateString(LOCALE, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </span>
              ) : (
                <Skeleton className="h-3 w-20" />
              )
            }
          >
            <Tiles>
              <Tile icon={<MessageSquareText size={16} />} label="Turns answered">
                {stats && <CountUp value={stats.totals.turns} />}
              </Tile>
              <Tile icon={<Clock size={16} />} label="Time worked">
                {stats && <CountUp value={stats.totals.workedMs} format={duration} />}
              </Tile>
              <Tile icon={<MessagesSquare size={16} />} label="Conversations">
                {stats && <CountUp value={stats.totals.conversations} />}
              </Tile>
              <Tile icon={<GraduationCap size={16} />} label="Skills and memories kept">
                {stats && <CountUp value={stats.totals.skillsWritten + stats.totals.memories} />}
              </Tile>
            </Tiles>
          </Part>
          <Part
            title="Usage"
            action={<Segmented label="Period" value={days} onChange={onDays} options={periods} />}
          >
            <UsageSummary stats={stats} />
          </Part>
          {stats && stats.channels.length > 0 && (
            <Part title="Channels">
              <ChannelCards stats={stats} />
            </Part>
          )}
        </div>
      )}
    </>
  );
}

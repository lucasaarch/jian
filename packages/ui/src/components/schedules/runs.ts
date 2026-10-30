import { useQuery } from '@tanstack/react-query';
import type { GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { statusLabels } from '../sessions/status';

/** One time a schedule ran, or tried to. */
export type ScheduleRun = Awaited<ReturnType<GatewayApi['scheduleHistory']>>[number];

/**
 * How a time went: a time that started no run failed, as did a run that failed or was
 * interrupted; anything else not completed is still on its way.
 */
export const runOutcome = (entry: ScheduleRun): 'done' | 'failed' | 'running' =>
  !entry.runId
    ? 'failed'
    : entry.status === 'completed'
      ? 'done'
      : entry.status === 'failed' || entry.status === 'interrupted'
        ? 'failed'
        : 'running';

/** The run's state in words, or that none started. */
export const runStatus = (entry: ScheduleRun) =>
  entry.runId
    ? (statusLabels[entry.status as keyof typeof statusLabels] ?? entry.status)
    : 'Did not start';

/** What a schedule did in the last thirty days, newest first, as the gateway keeps it. */
export function useScheduleRuns(
  api: Pick<GatewayApi, 'scheduleHistory'>,
  profileId: string,
  scheduleId: string,
) {
  const history = useQuery({
    queryKey: keys.scheduleHistory(profileId, scheduleId),
    queryFn: () => api.scheduleHistory(profileId, scheduleId),
  });
  const error = history.error
    ? history.error instanceof Error
      ? history.error.message
      : 'The history could not load.'
    : '';

  return { entries: history.data, error };
}

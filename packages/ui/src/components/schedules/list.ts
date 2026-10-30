import { useQuery } from '@tanstack/react-query';
import type { GatewayApi, Schedule, ScheduleInput } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { browserTimeZone } from '../../lib/time';
import type { SectionActions } from '../props';

/** A single time that already ran: kept a week, faded, under the ones still to come. */
export const ranOnce = (item: Schedule) => !item.cron && !item.enabled && Boolean(item.lastRunAt);

/**
 * An agent's schedules, read through the section's own client — which a story or a test hands
 * in — ordered as they are listed: the repeating ones, then the single times still to come by
 * when they run, then those that ran, newest first. `zone` is the gateway's, which schedules
 * run in; this browser's until it is known.
 */
export function useScheduleList(
  api: Pick<GatewayApi, 'schedules' | 'settings'>,
  profileId: string,
) {
  const schedules = useQuery({
    queryKey: keys.schedules(profileId),
    queryFn: () => api.schedules(profileId),
  });
  const { data: settings } = useQuery({ queryKey: keys.settings, queryFn: () => api.settings() });
  const list = schedules.data;
  const error = schedules.error
    ? schedules.error instanceof Error
      ? schedules.error.message
      : 'The schedules could not load.'
    : '';
  const repeating = (list ?? []).filter((item) => item.cron);
  const single = (list ?? [])
    .filter((item) => !item.cron)
    .sort(
      (a, b) =>
        Number(ranOnce(a)) - Number(ranOnce(b)) ||
        (ranOnce(a)
          ? (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '')
          : (a.at ?? '').localeCompare(b.at ?? '')),
    );

  return { list, error, repeating, single, zone: settings?.timeZone ?? browserTimeZone() };
}

/**
 * What the owner does to an agent's schedules, each said in a notice once the gateway answers.
 * Every one resolves false when the gateway refused it.
 */
export function scheduleActions({ api, mutate }: Omit<SectionActions, 'busy'>, profileId: string) {
  return {
    /** A new schedule without `schedule`; otherwise its fields, and its time as `input` gives it. */
    save: (schedule: Schedule | undefined, input: ScheduleInput) =>
      schedule
        ? mutate(
            () =>
              api.updateSchedule(profileId, schedule.id, {
                name: input.name,
                instruction: input.instruction,
                sessionId: input.sessionId,
                timeZone: input.timeZone,
                ...(input.at ? { at: input.at } : { cron: input.cron }),
              }),
            `${input.name} saved.`,
          )
        : mutate(() => api.createSchedule(profileId, input), `${input.name} scheduled.`),
    run: (item: Schedule) =>
      mutate(() => api.runSchedule(profileId, item.id), `${item.name} started.`),
    switchTo: (item: Schedule, enabled: boolean) =>
      mutate(
        () => api.updateSchedule(profileId, item.id, { enabled }),
        enabled ? `${item.name} switched on.` : `${item.name} paused.`,
      ),
    remove: (item: Schedule) =>
      mutate(() => api.deleteSchedule(profileId, item.id), `${item.name} deleted.`),
  };
}

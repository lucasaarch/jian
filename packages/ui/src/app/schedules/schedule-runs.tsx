'use client';

import { Check, LoaderCircle, X } from 'lucide-react';
import { runOutcome, runStatus, useScheduleRuns } from '../../components/schedules/runs';
import { Action, Skeleton, SkeletonLine, StatusPill } from '../../kit';
import type { GatewayApi, Schedule } from '../../lib/api';
import { inZone } from '../../lib/time';

const marks = {
  done: <Check size={13} strokeWidth={2.5} className="text-good" aria-hidden="true" />,
  failed: <X size={13} strokeWidth={2.5} className="text-bad" aria-hidden="true" />,
  running: <LoaderCircle size={13} className="animate-spin text-muted" aria-hidden="true" />,
};

/** The card the runs are listed in, and the shape it takes while they are read. */
const card =
  'max-h-56 divide-y divide-glass-edge overflow-y-auto rounded-xl border border-glass-edge bg-glass-hover';
const line = 'flex h-10 items-center gap-2.5 px-3 text-[13px]';

/**
 * What a schedule did in the last thirty days, a line each, newest first: when it was due, how
 * it went and why not, and the way to the conversation it answered in. A schedule that opens a
 * new chat each time has no one conversation to go to.
 */
export function ScheduleRuns({
  api,
  profileId,
  schedule,
  onOpen,
}: {
  api: Pick<GatewayApi, 'scheduleHistory'>;
  profileId: string;
  schedule: Schedule;
  onOpen: (sessionId: string) => void;
}) {
  const { entries, error } = useScheduleRuns(api, profileId, schedule.id);
  const sessionId = schedule.sessionId;
  const reading = !entries && !error;

  return (
    <section className="grid gap-1.5" aria-label="Recent runs">
      <span className="text-[13px] font-medium text-ink">Recent runs</span>
      {/* Kept in place and out of the busy list, so a screen reader hears the change. */}
      <p role="status" className="sr-only">
        {reading ? 'Loading recent runs…' : ''}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : !entries ? (
        <ul aria-busy="true" className={card}>
          {['w-28', 'w-32'].map((width) => (
            <li key={width} className={line}>
              <Skeleton className="size-[13px] rounded-full" />
              <SkeletonLine className={width} />
              <span className="min-w-0 flex-1 text-xs">
                <SkeletonLine className="w-2/5" />
              </span>
            </li>
          ))}
        </ul>
      ) : entries.length ? (
        <ul className={card}>
          {entries.map((entry) => {
            const status = runStatus(entry);
            const said = entry.error ? `${status}: ${entry.error}` : status;

            return (
              <li key={entry.id} className={line}>
                {marks[runOutcome(entry)]}
                <span className="shrink-0 tabular-nums">
                  {inZone(entry.dueAt, schedule.timeZone)}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted" title={said}>
                  {said}
                </span>
                {entry.manual && <StatusPill>By hand</StatusPill>}
                {entry.runId && sessionId && (
                  <Action tone="quiet" size="small" onClick={() => onOpen(sessionId)}>
                    Open
                  </Action>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted">Not run yet. It runs next at its time.</p>
      )}
    </section>
  );
}

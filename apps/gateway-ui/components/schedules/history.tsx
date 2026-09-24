'use client';

import { ArrowUpRight, Check, LoaderCircle, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { GatewayApi, Schedule, ScheduleRun } from '../../lib/api';
import { inZone } from '../../lib/time';
import { statusLabels } from '../sessions/status';
import { Badge, Empty, Modal } from '../ui';

/**
 * What a repeating schedule did in the last thirty days, as a timeline: newest first, a mark
 * for how each time went, the reason when it did not, and the way to the conversation.
 */
export function ScheduleHistory({
  api,
  profileId,
  schedule,
  close,
}: {
  api: Pick<GatewayApi, 'scheduleHistory'>;
  profileId: string;
  schedule: Schedule;
  close: () => void;
}) {
  const [entries, setEntries] = useState<ScheduleRun[]>();
  const [error, setError] = useState('');

  useEffect(() => {
    void api
      .scheduleHistory(profileId, schedule.id)
      .then(setEntries)
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'The history could not load.'),
      );
  }, [api, profileId, schedule.id]);

  return (
    <Modal title={schedule.name} description="The last 30 days." close={close}>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : !entries ? (
        <div className="history-loading" role="status">
          <LoaderCircle size={20} className="spin" />
          Loading the history…
        </div>
      ) : entries.length ? (
        <ol className="schedule-history">
          {entries.map((entry, index) => {
            const outcome = !entry.runId
              ? 'failed'
              : entry.status === 'completed'
                ? 'done'
                : entry.status === 'failed' || entry.status === 'interrupted'
                  ? 'failed'
                  : 'running';

            return (
              <li
                key={entry.id}
                data-outcome={outcome}
                style={{ '--i': index } as React.CSSProperties}
              >
                <span className="history-mark" aria-hidden="true">
                  {outcome === 'done' ? (
                    <Check size={11} strokeWidth={3} />
                  ) : outcome === 'failed' ? (
                    <X size={11} strokeWidth={3} />
                  ) : (
                    <LoaderCircle size={11} className="spin" />
                  )}
                </span>
                <div className="history-body">
                  <div className="history-head">
                    <strong>{inZone(entry.dueAt, schedule.timeZone)}</strong>
                    <span className="history-status">
                      {entry.runId
                        ? (statusLabels[entry.status as keyof typeof statusLabels] ?? entry.status)
                        : 'Did not start'}
                    </span>
                    {entry.manual && <Badge dot={false}>Run by hand</Badge>}
                  </div>
                  {entry.error && <p className="run-error">{entry.error}</p>}
                  {entry.runId && (
                    <Link href={`/sessions?session=${schedule.sessionId}`} onClick={close}>
                      Open the conversation
                      <ArrowUpRight size={13} />
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <Empty title="Not run yet">It runs next at the time on the list.</Empty>
      )}
    </Modal>
  );
}

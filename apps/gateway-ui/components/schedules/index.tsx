'use client';

import {
  AlarmClock,
  History,
  Pencil,
  Play,
  Plus,
  Repeat,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Schedule } from '../../lib/api';
import { browserTimeZone, describeCron, inZone } from '../../lib/time';
import { useWorkspace } from '../../lib/workspace';
import type { SectionProps } from '../props';
import { Badge, Button, Confirm, Empty, ResourceRow, SectionHeading, Switch } from '../ui';
import { conversationName } from './conversations';
import { ScheduleEditor } from './editor';
import { ScheduleHistory } from './history';

/**
 * What the agent does at a time: reminders, summaries, recurring checks, each in one of the
 * profile's conversations. The owner and the agent manage the same list.
 */
export function Schedules({ profile, data, api, mutate, busy }: SectionProps) {
  const { profiles, subscribe } = useWorkspace();
  const [list, setList] = useState<Schedule[]>();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Schedule | 'new'>();
  const [removing, setRemoving] = useState<Schedule>();
  const [zone, setZone] = useState(browserTimeZone());
  const [history, setHistory] = useState<Schedule>();

  useEffect(() => {
    void api
      .settings()
      .then((settings) => setZone(settings.timeZone))
      .catch(() => {});
  }, [api]);

  const load = useCallback(
    () =>
      api
        .schedules(profile.id)
        .then((items) => {
          setList(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'The schedules could not load.'),
        ),
    [api, profile.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The agent writes schedules too, and every run changes when one ran last.
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type.startsWith('schedule.')) void load();
      }),
    [subscribe, load],
  );

  const change = async (action: () => Promise<unknown>, done: string) => {
    const ok = await mutate(action, done);

    if (ok) await load();
    return ok;
  };
  const conversations = data.sessions.map((session) => ({
    session,
    ...conversationName(session, data.contacts, profiles),
  }));
  const where = (sessionId: string) =>
    conversations.find((item) => item.session.id === sessionId) ?? {
      name: 'A deleted conversation',
      where: '',
    };
  const gateway = data.sessions.find((session) => session.channel === 'gateway');
  /** A single time that already ran: kept a week, faded, under the ones still to come. */
  const done = (item: Schedule) => !item.cron && !item.enabled && Boolean(item.lastRunAt);
  const repeating = (list ?? []).filter((item) => item.cron);
  const single = (list ?? [])
    .filter((item) => !item.cron)
    .sort(
      (a, b) =>
        Number(done(a)) - Number(done(b)) ||
        (done(a)
          ? (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '')
          : (a.at ?? '').localeCompare(b.at ?? '')),
    );

  const row = (item: Schedule) => {
    const target = where(item.sessionId);

    return (
      <div key={item.id} className="schedule-row" data-done={done(item)}>
        <ResourceRow
          id={`schedule-${item.id}`}
          icon={
            item.cron ? (
              <Repeat size={20} strokeWidth={1.6} />
            ) : (
              <AlarmClock size={20} strokeWidth={1.6} />
            )
          }
          name={item.name}
          badges={
            <>
              <Badge dot={false}>
                {item.cron
                  ? describeCron(item.cron)
                  : item.at
                    ? inZone(item.at, item.timeZone)
                    : 'Once'}
              </Badge>
              {done(item) && <Badge tone="good">Ran</Badge>}
              {item.createdBy === 'agent' && <Badge tone="accent">By the agent</Badge>}
              {item.lastError && <Badge tone="bad">Last run failed</Badge>}
            </>
          }
          description={item.instruction}
          extra={
            item.lastError ? (
              <p className="row-error" role="status">
                <TriangleAlert size={14} />
                {item.lastError}
              </p>
            ) : undefined
          }
          facts={[
            `In ${target.name}${target.where ? ` · ${target.where}` : ''}`,
            ...(done(item)
              ? [`Ran ${inZone(item.lastRunAt ?? '', item.timeZone)}`]
              : [
                  item.enabled && item.nextRunAt
                    ? `Next ${inZone(item.nextRunAt, item.timeZone)}`
                    : 'Paused',
                  ...(item.cron && item.lastRunAt
                    ? [`Last ${inZone(item.lastRunAt, item.timeZone)}`]
                    : []),
                ]),
            ...(item.timeZone !== zone ? [item.timeZone.replaceAll('_', ' ')] : []),
          ]}
          actions={
            <>
              {item.cron && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`History of ${item.name}`}
                  title="History"
                  onClick={() => setHistory(item)}
                >
                  <History size={16} />
                </button>
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={`Run ${item.name} now`}
                title="Run now"
                disabled={busy}
                onClick={() =>
                  void change(() => api.runSchedule(profile.id, item.id), `${item.name} started.`)
                }
              >
                <Play size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Edit ${item.name}`}
                onClick={() => setEditing(item)}
              >
                <Pencil size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${item.name}`}
                onClick={() => setRemoving(item)}
              >
                <Trash2 size={16} />
              </button>
              {!done(item) && (
                <Switch
                  checked={item.enabled}
                  label={`${item.name} ${item.enabled ? 'on' : 'off'}`}
                  disabled={busy}
                  onChange={(enabled) =>
                    void change(
                      () => api.updateSchedule(profile.id, item.id, { enabled }),
                      enabled ? `${item.name} switched on.` : `${item.name} paused.`,
                    )
                  }
                />
              )}
            </>
          }
        />
      </div>
    );
  };

  return (
    <>
      <SectionHeading
        title="Schedules"
        description="Reminders, summaries and checks the agent runs at a time, in the conversation you choose. It can create and change them too."
        action={
          <Button onClick={() => setEditing('new')}>
            <Plus size={16} />
            New schedule
          </Button>
        }
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {list?.length ? (
        <>
          {repeating.length > 0 && (
            <section className="row-group" aria-labelledby="schedules-repeat">
              <h2 id="schedules-repeat">Repeat</h2>
              <div className="resource-list">{repeating.map(row)}</div>
            </section>
          )}
          {single.length > 0 && (
            <section className="row-group" aria-labelledby="schedules-once">
              <h2 id="schedules-once">Once</h2>
              <p>A single time that ran stays here, faded, for 7 days.</p>
              <div className="resource-list">{single.map(row)}</div>
            </section>
          )}
        </>
      ) : list ? (
        <Empty title="Nothing scheduled">
          Ask the agent — “remind me at 3pm to call Maya”, “every morning send me a summary on
          WhatsApp” — or create one here.
        </Empty>
      ) : null}
      {history && (
        <ScheduleHistory
          api={api}
          profileId={profile.id}
          schedule={history}
          close={() => setHistory(undefined)}
        />
      )}
      {editing && (
        <ScheduleEditor
          key={editing === 'new' ? 'new' : editing.id}
          schedule={editing === 'new' ? undefined : editing}
          sessions={conversations}
          defaultSession={gateway?.id ?? data.sessions[0]?.id ?? ''}
          zone={zone}
          busy={busy}
          close={() => setEditing(undefined)}
          save={(input) =>
            editing === 'new'
              ? change(() => api.createSchedule(profile.id, input), `${input.name} scheduled.`)
              : change(
                  () =>
                    api.updateSchedule(profile.id, editing.id, {
                      name: input.name,
                      instruction: input.instruction,
                      sessionId: input.sessionId,
                      timeZone: input.timeZone,
                      ...(input.at ? { at: input.at } : { cron: input.cron }),
                    }),
                  `${input.name} saved.`,
                )
          }
        />
      )}
      {removing && (
        <Confirm
          title={`Delete ${removing.name}?`}
          description="It will not run again. To stop it for a while instead, switch it off."
          busy={busy}
          close={() => setRemoving(undefined)}
          confirm={async () => {
            if (
              await change(
                () => api.deleteSchedule(profile.id, removing.id),
                `${removing.name} deleted.`,
              )
            )
              setRemoving(undefined);
          }}
        />
      )}
    </>
  );
}

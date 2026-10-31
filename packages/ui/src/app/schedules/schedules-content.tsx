'use client';

import { AlarmClock, CalendarClock, Plus } from 'lucide-react';
import { Suspense, useState } from 'react';
import { choices } from '../../components/schedules/conversations';
import { ranOnce, scheduleActions, useScheduleList } from '../../components/schedules/list';
import {
  ConfirmDialog,
  Overlay,
  SettingsLayout,
  type SettingsPage,
  Skeleton,
  SkeletonRegion,
} from '../../kit';
import type { Schedule } from '../../lib/api';
import { agentPath } from '../../lib/navigation';
import { useAgent, useAgents, useContacts, useSessions } from '../../lib/query/agent';
import { useAgentOverlay } from '../../lib/stores/agent-overlay';
import { useActions } from '../../lib/workspace';
import { useRouter } from '../../platform/navigation';
import { ScheduleForm } from './schedule-form';

const pageOf = (item: Schedule, group: string): SettingsPage => ({
  id: item.id,
  label: item.name,
  group,
  icon: item.cron ? <AlarmClock size={15} /> : <CalendarClock size={15} />,
  keywords: [item.instruction],
  ...(item.lastError
    ? {
        trailing: (
          <span className="size-1.5 shrink-0 rounded-full bg-bad">
            <span className="sr-only">Failed</span>
          </span>
        ),
      }
    : !item.enabled && !ranOnce(item)
      ? { trailing: <span className="text-[11px] text-muted">Paused</span> }
      : {}),
});

/** Says "New" for the corner it sits in; the list beside it says of what. */
const NewSchedule = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    aria-label="New schedule"
    onClick={onClick}
    className="flex h-8 w-fit items-center gap-1.5 px-2 text-[13px] text-muted transition-colors hover:text-ink"
  >
    <Plus size={15} />
    New
  </button>
);

const shared = {
  searchLabel: 'Search schedules',
  emptyLabel: 'No schedule matches.',
  backLabel: 'Schedules',
} as const;

/** The schedules while the agent is read: the same overlay, its list and form still to come. */
function SchedulesWaiting() {
  return (
    <SettingsLayout {...shared} pages={[]} current="" onSelect={() => undefined} title="Schedules">
      <SkeletonRegion label="Loading schedules…" className="grid gap-4">
        <Skeleton className="h-10 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-10 rounded-lg" />
      </SkeletonRegion>
    </SettingsLayout>
  );
}

/**
 * What the agent does at a time — reminders, summaries, recurring checks — down the left, and all
 * of the one open on the right. The owner and the agent manage the same list; removing one asks
 * for its name first.
 */
function Schedules() {
  const { api, mutate, busy } = useActions();
  const profile = useAgent();
  const sessions = useSessions();
  const contacts = useContacts();
  const profiles = useAgents();
  const router = useRouter();
  const asked = useAgentOverlay((state) => state.schedule);
  const select = useAgentOverlay((state) => state.selectSchedule);
  const close = useAgentOverlay((state) => state.closeSchedules);
  const { list, error, repeating, single, zone } = useScheduleList(api, profile.id);
  // An action reloads the agent's queries, the schedules and their runs among them.
  const act = scheduleActions({ api, mutate }, profile.id);
  // The schedule asked about stays named while its dialog fades out.
  const [removing, setRemoving] = useState<Schedule>();
  const [asking, setAsking] = useState(false);

  if (!list && !error) return <SchedulesWaiting />;

  const ordered = [...repeating, ...single];
  const pages = [
    ...repeating.map((item) => pageOf(item, 'Repeating')),
    ...single.map((item) => pageOf(item, 'Once')),
  ];
  // The one asked for, or else the first; with none yet, the way to write one.
  const writing = asked === 'new' || ordered.length === 0;
  const schedule = writing ? undefined : (ordered.find((item) => item.id === asked) ?? ordered[0]);

  return (
    <>
      <SettingsLayout
        {...shared}
        pages={pages}
        current={schedule?.id ?? 'new'}
        onSelect={select}
        title={schedule?.name ?? 'New schedule'}
        startOnPage={Boolean(asked)}
        action={<NewSchedule onClick={() => select('new')} />}
      >
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        <ScheduleForm
          key={schedule?.id ?? 'new'}
          api={api}
          profileId={profile.id}
          schedule={schedule}
          choices={choices(sessions, contacts, profiles)}
          zone={zone}
          busy={busy}
          onSave={(input) => void act.save(schedule, input, select)}
          onRun={() => schedule && void act.run(schedule)}
          onSwitch={(enabled) =>
            schedule ? act.switchTo(schedule, enabled) : Promise.resolve(false)
          }
          onRemove={() => {
            setRemoving(schedule);
            setAsking(true);
          }}
          onOpenConversation={(sessionId) => {
            close();
            router.push(agentPath(profile.id, `sessions/${sessionId}`));
          }}
          onCancel={writing && ordered.length > 0 ? () => select(undefined) : undefined}
        />
      </SettingsLayout>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${removing?.name ?? ''}?`}
        phrase={removing?.name ?? ''}
        action="Remove schedule"
        busy={busy}
        run={async () => {
          if (!removing || !(await act.remove(removing))) return;
          setAsking(false);
          select(undefined);
        }}
      >
        It will not run again. To stop it for a while instead, pause it with its switch.
      </ConfirmDialog>
    </>
  );
}

/** The agent's schedules, over its conversation, as settings are. */
export function SchedulesOverlay() {
  const open = useAgentOverlay((state) => state.schedules);
  const close = useAgentOverlay((state) => state.closeSchedules);

  return (
    <Overlay
      open={open}
      onOpenChange={(next) => !next && close()}
      title="Schedules"
      closeButton={false}
    >
      <Suspense fallback={<SchedulesWaiting />}>
        <Schedules />
      </Suspense>
    </Overlay>
  );
}

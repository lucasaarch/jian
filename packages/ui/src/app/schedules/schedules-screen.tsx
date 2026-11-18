'use client';

import { AlarmClock, CalendarClock, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { choices } from '../../components/schedules/conversations';
import { scheduleActions, useScheduleList } from '../../components/schedules/list';
import {
  Action,
  ConfirmDialog,
  PageBody,
  PageHeading,
  PageToolbar,
  SearchField,
  SectionHeading,
  Skeleton,
  SkeletonRegion,
  surfaceCard,
} from '../../kit';
import type { Schedule } from '../../lib/api';
import { agentPath, schedulesPath } from '../../lib/navigation';
import { useAgents, useContacts, useSessions } from '../../lib/query/agent';
import { useNoInspector } from '../../lib/stores/screen';
import { useActions } from '../../lib/workspace';
import { useRouter, useSearchParams } from '../../platform/navigation';
import { ScheduleForm } from './schedule-form';
import { SchedulePills } from './schedule-standing';

/** The address's value for a schedule being written. */
const NEW = 'new';

/** One section of the list: each schedule a line, opened in full by a press. */
function ScheduleRows({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: Schedule[];
  onOpen: (id: string) => void;
}) {
  return (
    <section aria-label={title} className="grid min-w-0 grid-cols-1 gap-2">
      <SectionHeading title={title} />
      <ul className={`divide-y divide-glass-edge overflow-hidden ${surfaceCard}`}>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onOpen(item.id)}
              className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-glass-press"
            >
              <span className="grid size-4 shrink-0 place-items-center text-muted">
                {item.cron ? (
                  <AlarmClock size={15} aria-hidden="true" />
                ) : (
                  <CalendarClock size={15} aria-hidden="true" />
                )}
              </span>
              <span className="grid min-w-0 flex-1 grid-cols-1 gap-0.5">
                <span className="truncate text-[13px] text-ink">{item.name}</span>
                <span className="truncate text-xs text-muted">{item.instruction}</span>
              </span>
              <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <SchedulePills item={item} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What the agent does at a time — reminders, summaries, recurring checks — in place of the chat,
 * with the sidebar beside it as every screen there has: a page of the kit's one anatomy, its
 * list searched from the toolbar, a new one written from its end. One opens in full on the
 * same page, its way back in its heading. The one open is in the address (`?schedule=`, `new`
 * for one being written), so the browser's back comes to the list as the heading's does. The
 * owner and the agent manage the same list; removing one asks for its name first.
 */
export function SchedulesScreen({ profileId }: { profileId: string }) {
  useNoInspector();
  const { api, mutate, busy } = useActions();
  const sessions = useSessions();
  const contacts = useContacts();
  const profiles = useAgents();
  const router = useRouter();
  const { list, error, repeating, single, zone } = useScheduleList(api, profileId);
  // An action reloads the agent's queries, the schedules and their runs among them.
  const act = scheduleActions({ api, mutate }, profileId);
  const [typed, setTyped] = useState('');
  // The schedule asked about stays named while its dialog fades out.
  const [removing, setRemoving] = useState<Schedule>();
  const [asking, setAsking] = useState(false);

  const opened = useSearchParams().get('schedule') ?? undefined;
  // The one last opened from the list, whose way back is the history's step back; one the
  // address opened has nothing behind it here, and the list takes its place instead.
  const pushed = useRef<string>(undefined);
  const open = (id: string) => {
    pushed.current = id;
    router.push(`${schedulesPath(profileId)}?schedule=${encodeURIComponent(id)}`);
  };
  const close = () => {
    const back = opened !== undefined && pushed.current === opened;
    pushed.current = undefined;
    if (back) router.back();
    else router.replace(schedulesPath(profileId));
  };

  const writing = opened === NEW;
  // One deleted meanwhile, by the agent or elsewhere, is no longer listed: the list.
  const schedule = writing ? undefined : list?.find((item) => item.id === opened);

  const removal = (
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
        close();
      }}
    >
      It will not run again. To stop it for a while instead, pause it with its switch.
    </ConfirmDialog>
  );

  if (writing || schedule) {
    const title = schedule?.name ?? 'New schedule';
    return (
      <div className="flex h-full min-h-0">
        <PageBody label={title}>
          <PageHeading title={title} onBack={close} backLabel="Schedules" />
          <ScheduleForm
            key={schedule?.id ?? NEW}
            api={api}
            profileId={profileId}
            schedule={schedule}
            choices={choices(sessions, contacts, profiles)}
            zone={zone}
            busy={busy}
            // A new one, once made, is found in the list it goes back to.
            onSave={(input) =>
              void act.save(schedule, input).then((saved) => {
                if (saved && !schedule) close();
              })
            }
            onRun={() => schedule && void act.run(schedule)}
            onSwitch={(enabled) =>
              schedule ? act.switchTo(schedule, enabled) : Promise.resolve(false)
            }
            onRemove={() => {
              setRemoving(schedule);
              setAsking(true);
            }}
            onOpenConversation={(sessionId) =>
              router.push(agentPath(profileId, `sessions/${encodeURIComponent(sessionId)}`))
            }
            onCancel={writing ? close : undefined}
          />
        </PageBody>
        {removal}
      </div>
    );
  }

  const words = typed.trim().toLowerCase();
  const matches = (item: Schedule) =>
    !words || `${item.name} ${item.instruction}`.toLowerCase().includes(words);
  const shownRepeating = repeating.filter(matches);
  const shownSingle = single.filter(matches);

  return (
    <div className="flex h-full min-h-0">
      <PageBody labelledBy="schedules-title">
        <PageHeading
          id="schedules-title"
          title="Schedules"
          description="What the agent does at a time: reminders, summaries, recurring checks."
        />
        <PageToolbar>
          <SearchField
            label="Search schedules"
            className="min-w-44 flex-1"
            value={typed}
            onValueChange={setTyped}
          />
          <Action tone="outline" size="field" onClick={() => open(NEW)}>
            <Plus size={14} aria-hidden="true" />
            New schedule
          </Action>
        </PageToolbar>
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        {!list && !error ? (
          <SkeletonRegion label="Loading schedules…" className="grid gap-2">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-14 rounded-xl" />
            ))}
          </SkeletonRegion>
        ) : shownRepeating.length + shownSingle.length === 0 ? (
          list && (
            <p className={`px-4 py-3 text-[13px] text-muted ${surfaceCard}`}>
              {words
                ? 'No schedule matches.'
                : 'Nothing scheduled yet. Create one here, or ask the agent in a chat to do something later or on a repetition.'}
            </p>
          )
        ) : (
          <>
            {shownRepeating.length > 0 && (
              <ScheduleRows title="Repeating" items={shownRepeating} onOpen={open} />
            )}
            {shownSingle.length > 0 && (
              <ScheduleRows title="Once" items={shownSingle} onOpen={open} />
            )}
          </>
        )}
      </PageBody>
      {removal}
    </div>
  );
}

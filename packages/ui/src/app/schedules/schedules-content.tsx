'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { choices } from '../../components/schedules/conversations';
import { scheduleActions, useScheduleList } from '../../components/schedules/list';
import {
  Action,
  ConfirmDialog,
  SettingsGroup,
  SettingsRow,
  SettingsRowSkeleton,
  SettingsRowsSkeleton,
  SkeletonRegion,
} from '../../kit';
import type { Schedule } from '../../lib/api';
import { agentPath } from '../../lib/navigation';
import { useAgent, useAgents, useContacts, useSessions } from '../../lib/query/agent';
import { useActions } from '../../lib/workspace';
import { useRouter } from '../../platform/navigation';
import { ScheduleDialog } from './schedule-dialog';
import { ScheduleRow } from './schedule-row';

/** A few schedules' shape: a name with how it stands, its switch and Configure. */
const ScheduleRowsWaiting = () => <SettingsRowsSkeleton count={2} pill toggle />;

/**
 * The schedules while the agent is read, as the list will stand while its schedules are: their
 * rows' shape, then the row that adds one.
 */
export function SchedulesWaiting() {
  return (
    <SkeletonRegion label="Loading schedules…" className="grid grid-cols-1">
      <SettingsGroup>
        <ScheduleRowsWaiting />
        <SettingsRowSkeleton index={2} />
      </SettingsGroup>
    </SkeletonRegion>
  );
}

/**
 * What the agent does at a time — reminders, summaries, recurring checks — a line each, with its
 * switch and Configure, and the way to add another. The owner and the agent manage the same
 * list; removing one asks for its name first.
 */
export function SchedulesContent() {
  const { api, mutate, busy } = useActions();
  const profile = useAgent();
  const sessions = useSessions();
  const contacts = useContacts();
  const profiles = useAgents();
  const router = useRouter();
  const { list, error, repeating, single, zone } = useScheduleList(api, profile.id);
  // An action reloads the agent's queries, the schedules and their runs among them.
  const act = scheduleActions({ api, mutate }, profile.id);
  // What the form edits stays set while it closes, so it fades out as it was; read from the
  // list each render, so a run or a switch shows in it at once.
  const [editing, setEditing] = useState<Schedule>();
  const current = editing && (list?.find((item) => item.id === editing.id) ?? editing);
  const [formOpen, setFormOpen] = useState(false);
  const [round, setRound] = useState(0);
  // The schedule asked about stays named while its dialog fades out.
  const [removing, setRemoving] = useState<Schedule>();
  const [asking, setAsking] = useState(false);

  const edit = (target: Schedule | undefined) => {
    setEditing(target);
    setRound((count) => count + 1);
    setFormOpen(true);
  };

  const reading = !list && !error;
  const note = error ? (
    <span role="alert" className="text-bad">
      {error}
    </span>
  ) : undefined;

  return (
    <>
      <SettingsGroup note={note} loading={reading && 'Loading schedules…'}>
        {reading && <ScheduleRowsWaiting />}
        {[...repeating, ...single].map((item) => (
          <ScheduleRow
            key={item.id}
            item={item}
            onSwitch={(enabled) => act.switchTo(item, enabled)}
            onConfigure={() => edit(item)}
          />
        ))}
        <SettingsRow
          title={list?.length === 0 ? 'Nothing scheduled' : 'Add a schedule'}
          {...(list?.length === 0
            ? {
                description: 'Ask the agent in a chat, or add one here.',
              }
            : {})}
        >
          <Action tone="outline" size="small" onClick={() => edit(undefined)}>
            <Plus size={13} />
            Add
          </Action>
        </SettingsRow>
      </SettingsGroup>
      <ScheduleDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        round={round}
        api={api}
        profileId={profile.id}
        schedule={current}
        choices={choices(sessions, contacts, profiles)}
        zone={zone}
        busy={busy}
        onSave={(input) =>
          void act.save(current, input).then((ok) => {
            if (ok) setFormOpen(false);
          })
        }
        onRun={() => current && void act.run(current)}
        onRemove={() => {
          setRemoving(current);
          setAsking(true);
        }}
        onOpenConversation={(sessionId) => {
          setFormOpen(false);
          router.push(agentPath(profile.id, `sessions/${sessionId}`));
        }}
      />
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
          setFormOpen(false);
        }}
      >
        It will not run again. To stop it for a while instead, pause it with its switch.
      </ConfirmDialog>
    </>
  );
}

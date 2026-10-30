'use client';

import { MessageSquarePlus } from 'lucide-react';
import { marks, NEW_CHAT } from '../../components/schedules/conversation-marks';
import type { Choice } from '../../components/schedules/conversations';
import { useScheduleDraft } from '../../components/schedules/draft';
import { ranOnce } from '../../components/schedules/list';
import { Action, Overlay, SelectField, TextArea, TextField } from '../../kit';
import type { GatewayApi, Schedule, ScheduleInput } from '../../lib/api';
import { inZone } from '../../lib/time';
import { SchedulePills } from './schedule-row';
import { ScheduleRuns } from './schedule-runs';
import { ScheduleWhen } from './schedule-when';

/** The conversation picker's value for a new chat each time: session ids are UUIDs. */
const NEW = 'new';

type FormProps = {
  api: Pick<GatewayApi, 'scheduleHistory'>;
  profileId: string;
  /** The schedule to configure; a new one without it. */
  schedule?: Schedule | undefined;
  /** The conversations it can run in, in the order they are offered. */
  choices: Choice[];
  /** The gateway's zone, which a new schedule is written in. */
  zone: string;
  busy: boolean;
  onSave: (input: ScheduleInput) => void;
  onRun: () => void;
  onRemove: () => void;
  onOpenConversation: (sessionId: string) => void;
};

/**
 * Adds a schedule, or configures one: what it asks, where it answers and when, what it did
 * lately, running it now and removing it. `round` changes on every opening, so each starts from
 * the schedule and nothing typed outlives a cancel.
 */
export function ScheduleDialog({
  open,
  onOpenChange,
  round,
  ...form
}: { open: boolean; onOpenChange: (open: boolean) => void; round: number } & FormProps) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={form.schedule ? form.schedule.name : 'Add a schedule'}
      size="form"
    >
      <ScheduleForm key={round} {...form} onCancel={() => onOpenChange(false)} />
    </Overlay>
  );
}

/** What is known of a saved schedule beyond its fields, a fact to a part of one line. */
function factsOf(item: Schedule, zone: string) {
  return [
    ranOnce(item)
      ? `Ran ${inZone(item.lastRunAt ?? '', item.timeZone)}`
      : item.enabled && item.nextRunAt
        ? `Next ${inZone(item.nextRunAt, item.timeZone)}`
        : 'Paused',
    item.cron && item.lastRunAt ? `Last ${inZone(item.lastRunAt, item.timeZone)}` : '',
    item.createdBy === 'agent' ? 'Created by the agent' : '',
    item.timeZone !== zone ? item.timeZone.replaceAll('_', ' ') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function ScheduleForm({
  api,
  profileId,
  schedule,
  choices,
  zone,
  busy,
  onSave,
  onRun,
  onRemove,
  onOpenConversation,
  onCancel,
}: FormProps & { onCancel: () => void }) {
  const draft = useScheduleDraft(schedule, zone);
  const chosen = draft.sessionId ?? NEW;
  const options = [
    {
      value: NEW,
      label: NEW_CHAT.name,
      detail: NEW_CHAT.where,
      icon: <MessageSquarePlus size={14} aria-hidden="true" />,
    },
    ...choices.map((choice) => ({
      value: choice.session.id,
      label: choice.name,
      detail: choice.where,
      icon: marks[choice.provider],
    })),
    // Kept selectable as it is, so saving other changes does not move the schedule.
    ...(draft.sessionId && !choices.some((choice) => choice.session.id === draft.sessionId)
      ? [{ value: draft.sessionId, label: 'A deleted conversation' }]
      : []),
  ];

  return (
    <form
      className="grid w-full gap-5 p-7"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.ready) onSave(draft.input());
      }}
    >
      <header className="grid gap-1 pr-6">
        <h2 className="flex min-w-0 items-center gap-2.5 text-lg font-semibold tracking-tight">
          <span className="truncate">{schedule ? schedule.name : 'Add a schedule'}</span>
          {schedule && <SchedulePills item={schedule} enabled={schedule.enabled} />}
        </h2>
        <p className="text-sm text-muted">
          {schedule
            ? factsOf(schedule, zone)
            : 'At the time, the agent receives the instruction in the conversation you choose, and answers there.'}
        </p>
      </header>
      {schedule?.lastError && (
        <p className="rounded-lg bg-bad/10 px-3 py-2.5 text-xs leading-relaxed text-bad">
          {schedule.lastError}
        </p>
      )}
      <TextField
        label="Name"
        hint="Short, for the list."
        required
        maxLength={80}
        placeholder="Morning summary"
        autoComplete="off"
        value={draft.name}
        onChange={(event) => draft.setName(event.target.value)}
      />
      <TextArea
        label="Instruction"
        hint="What the agent is asked at the time, with everything it needs."
        required
        maxLength={4000}
        rows={4}
        placeholder="Send me a summary of yesterday's conversations and what is due today."
        value={draft.instruction}
        onChange={(event) => draft.setInstruction(event.target.value)}
      />
      <SelectField
        label="Answers in"
        value={chosen}
        options={options}
        searchable
        onValueChange={(value) => draft.setSessionId(value === NEW ? null : value)}
      />
      <ScheduleWhen draft={draft} />
      {schedule && (
        <ScheduleRuns
          api={api}
          profileId={profileId}
          schedule={schedule}
          onOpen={onOpenConversation}
        />
      )}
      <div className="flex items-center gap-2">
        {schedule && (
          <>
            <Action tone="danger" className="bg-bad/10" disabled={busy} onClick={onRemove}>
              Remove
            </Action>
            <Action tone="outline" disabled={busy} onClick={onRun}>
              Run now
            </Action>
          </>
        )}
        <span className="flex-1" />
        <Action tone="quiet" onClick={onCancel}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy} disabled={!draft.ready}>
          {schedule ? 'Save' : 'Create'}
        </Action>
      </div>
    </form>
  );
}

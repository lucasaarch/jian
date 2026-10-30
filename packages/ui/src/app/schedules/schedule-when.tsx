'use client';

import { repeats, type ScheduleDraft } from '../../components/schedules/draft';
import { DateTimeField, Segmented, SelectField, TextField, TimeField } from '../../kit';
import { isoToZonedLocal, type Repeat, weekdays } from '../../lib/time';

/**
 * When a schedule runs: once, at a date and time, or on a repetition — a common one picked by
 * its parts, or a cron expression. Times are read in the schedule's own zone.
 */
export function ScheduleWhen({ draft }: { draft: ScheduleDraft }) {
  const zone = `In ${draft.timeZone.replaceAll('_', ' ')}.`;

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <span className="text-[13px] font-medium text-ink">When</span>
        <Segmented
          label="When"
          value={draft.kind}
          options={[
            { value: 'once', label: 'Once' },
            { value: 'repeat', label: 'Repeat' },
          ]}
          onChange={(kind) => draft.setKind(kind)}
        />
      </div>
      {draft.kind === 'once' ? (
        <DateTimeField
          label="Date and time"
          hint={zone}
          min={isoToZonedLocal(new Date().toISOString(), draft.timeZone)}
          value={draft.at}
          onChange={draft.setAt}
        />
      ) : (
        <>
          <SelectField
            label="Repeats"
            value={draft.repeat}
            options={repeats}
            onValueChange={(value) => draft.setRepeat(value as Repeat)}
          />
          {draft.repeat === 'weekly' && (
            <SelectField
              label="On"
              value={String(draft.weekday)}
              options={weekdays.map((label, index) => ({ value: String(index), label }))}
              onValueChange={(value) => draft.setWeekday(Number(value))}
            />
          )}
          {draft.repeat === 'monthly' && (
            <TextField
              label="Day of the month"
              type="number"
              min={1}
              max={31}
              required
              value={draft.day}
              onChange={(event) => draft.setDay(Number(event.target.value))}
            />
          )}
          {draft.repeat === 'custom' ? (
            <TextField
              label="Cron"
              hint={`minute hour day month weekday · at most every 5 minutes. ${zone}`}
              required
              spellCheck={false}
              autoComplete="off"
              value={draft.custom}
              onChange={(event) => draft.setCustom(event.target.value)}
            />
          ) : (
            <TimeField label="At" hint={zone} value={draft.time} onChange={draft.setTime} />
          )}
        </>
      )}
    </div>
  );
}

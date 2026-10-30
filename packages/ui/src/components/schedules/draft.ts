import { useState } from 'react';
import type { Schedule, ScheduleInput } from '../../lib/api';
import { cronFor, isoToZonedLocal, type Repeat, readCron, zonedToIso } from '../../lib/time';

export const repeats: Array<{ value: Repeat; label: string }> = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'custom', label: 'Custom (cron)' },
];

/**
 * A schedule being written or changed: what the agent is asked, where it answers, and when —
 * once, at a wall-clock time, or on a repetition. It keeps the zone it was written in; a new
 * one takes `zone`, the gateway's. `input` is what the gateway is sent.
 */
export function useScheduleDraft(schedule: Schedule | undefined, zone: string) {
  const timeZone = schedule?.timeZone ?? zone;
  const read = schedule?.cron ? readCron(schedule.cron) : undefined;
  const [name, setName] = useState(schedule?.name ?? '');
  const [instruction, setInstruction] = useState(schedule?.instruction ?? '');
  // A new schedule runs in a new chat each time until another conversation is chosen.
  const [sessionId, setSessionId] = useState<string | null>(schedule ? schedule.sessionId : null);
  const [kind, setKind] = useState<'once' | 'repeat'>(schedule?.cron ? 'repeat' : 'once');
  const [at, setAt] = useState(
    schedule?.at
      ? isoToZonedLocal(schedule.at, timeZone)
      : // An hour from now, on the five-minute grid the pickers offer.
        isoToZonedLocal(
          new Date(Math.ceil((Date.now() + 60 * 60_000) / 300_000) * 300_000).toISOString(),
          timeZone,
        ),
  );
  const [repeat, setRepeat] = useState<Repeat>(read?.repeat ?? 'daily');
  const [time, setTime] = useState(read?.time ?? '08:00');
  const [weekday, setWeekday] = useState(read?.weekday ?? 1);
  const [day, setDay] = useState(read?.day ?? 1);
  const [custom, setCustom] = useState(schedule?.cron ?? '0 8 * * *');
  const cron = repeat === 'custom' ? custom : cronFor(repeat, time, weekday, day);

  const input = (): ScheduleInput => ({
    name: name.trim(),
    instruction: instruction.trim(),
    sessionId,
    timeZone,
    enabled: schedule?.enabled ?? true,
    ...(kind === 'once' ? { at: zonedToIso(at, timeZone) } : { cron }),
  });

  return {
    timeZone,
    name,
    setName,
    instruction,
    setInstruction,
    sessionId,
    setSessionId,
    kind,
    setKind,
    at,
    setAt,
    repeat,
    setRepeat,
    time,
    setTime,
    weekday,
    setWeekday,
    day,
    setDay,
    custom,
    setCustom,
    /** Both a name and an instruction are written: the gateway refuses either empty. */
    ready: Boolean(name.trim() && instruction.trim()),
    input,
  };
}

export type ScheduleDraft = ReturnType<typeof useScheduleDraft>;

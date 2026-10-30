'use client';

import { Popover } from '@base-ui/react/popover';
import { CalendarDays, Clock } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Calendar, type Day } from './calendar';
import { control, Labelled } from './text-field';
import { TimeColumns } from './time-columns';

const trigger = `${control} flex h-10 min-w-0 items-center gap-2.5 text-left data-popup-open:border-ink/25 data-popup-open:bg-glass-press`;
const panel =
  'glass flex origin-(--transform-origin) rounded-2xl p-3 text-ink outline-none transition-[opacity,scale] duration-100 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0';
/** A time picked before any day falls on this one, and a day picked before any time at this. */
const MORNING = '09:00';

const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (date = new Date()): Day =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const said = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A field's trigger and the panel it opens, over the overlay a form is drawn in. */
function Picker({
  label,
  hint,
  shown,
  icon,
  children,
}: {
  label: string;
  hint?: string | undefined;
  /** What the field holds, in words; nothing yet when absent. */
  shown: string | undefined;
  icon: ReactNode;
  children: ReactNode;
}) {
  const id = useId();

  return (
    <Labelled label={label} {...(hint ? { hint } : {})} id={id}>
      <Popover.Root>
        <Popover.Trigger
          id={id}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={trigger}
        >
          <span className={`min-w-0 flex-1 truncate ${shown ? '' : 'text-muted/70'}`}>
            {shown ?? 'Not set'}
          </span>
          <span className="shrink-0 text-muted">{icon}</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-[60]">
            <Popover.Popup aria-label={label} className={panel}>
              {children}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </Labelled>
  );
}

/**
 * A day and a time, as `datetime-local` writes them (YYYY-MM-DDTHH:mm), picked from a month and
 * from hour and minute lists beside it. It says nothing of zones: the form tells which it is in.
 * Days before `min`'s cannot be picked.
 */
export function DateTimeField({
  label,
  hint,
  value,
  min,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  /** The earliest moment, written as `value` is; its day is the first that can be picked. */
  min?: string;
  onChange: (value: string) => void;
}) {
  const [day = '', time = ''] = value ? value.split('T') : [];
  const first = min?.slice(0, 10);
  // Today where the form's times are read, when it says so; this computer's otherwise.
  const today = first ?? localDay();

  return (
    <Picker
      label={label}
      hint={hint}
      shown={day ? `${said.format(new Date(`${day}T00:00:00Z`))} at ${time || MORNING}` : undefined}
      icon={<CalendarDays size={15} aria-hidden="true" />}
    >
      <Calendar
        value={day || undefined}
        min={first}
        today={today}
        onChange={(next) => onChange(`${next}T${time || MORNING}`)}
      />
      {/* As tall as the month beside it, the lists scrolling within. */}
      <div className="relative ml-3 w-[6.25rem] border-l border-glass-edge">
        <div className="absolute inset-0 pl-3">
          <TimeColumns value={time} onChange={(next) => onChange(`${day || today}T${next}`)} />
        </div>
      </div>
    </Picker>
  );
}

/** A time of day, HH:mm, picked from hour and minute lists. */
export function TimeField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Picker
      label={label}
      hint={hint}
      shown={value || undefined}
      icon={<Clock size={15} aria-hidden="true" />}
    >
      <div className="h-60">
        <TimeColumns value={value} onChange={onChange} />
      </div>
    </Picker>
  );
}

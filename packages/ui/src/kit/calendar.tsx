'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';

/** A day as forms write it, YYYY-MM-DD: no zone, so it never shifts a day either way. */
export type Day = string;

const pad = (value: number) => String(value).padStart(2, '0');
const dayOf = (date: Date): Day =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const dateOf = (day: Day) => new Date(`${day}T00:00:00Z`);

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const title = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const spoken = new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: 'UTC' });

const nav =
  'grid size-7 place-items-center rounded-md text-muted transition-colors hover:bg-glass-hover hover:text-ink disabled:pointer-events-none disabled:opacity-30';

/**
 * A month of days to pick one from, weeks starting on Sunday. Days before `min` cannot be picked,
 * nor can the months before it be reached; today is ringed. Six weeks always, so the month's
 * height never jumps as it changes. A day of the month before or after picks it and goes there.
 */
export function Calendar({
  value,
  min,
  today,
  onChange,
}: {
  value?: Day | undefined;
  min?: Day | undefined;
  today: Day;
  onChange: (day: Day) => void;
}) {
  // The first of the month on show.
  const [month, setMonth] = useState(() => `${(value || today).slice(0, 7)}-01`);
  const first = dateOf(month);
  const go = (to: Date) =>
    setMonth(dayOf(new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1))));
  const move = (by: number) =>
    go(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + by, 1)));
  const days = Array.from({ length: 42 }, (_, index) =>
    dayOf(
      new Date(
        Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1 - first.getUTCDay() + index),
      ),
    ),
  );

  return (
    <div className="grid w-60 content-start gap-2">
      <div className="flex items-center justify-between pl-1.5">
        <span className="text-[13px] font-medium text-ink" aria-live="polite">
          {title.format(first)}
        </span>
        <span className="flex">
          <button
            type="button"
            aria-label="Previous month"
            className={nav}
            disabled={Boolean(min && month <= min)}
            onClick={() => move(-1)}
          >
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Next month" className={nav} onClick={() => move(1)}>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {weekdays.map((weekday) => (
          <abbr
            key={weekday}
            title={weekday}
            className="grid h-6 place-items-center text-[11px] font-medium text-muted no-underline"
          >
            {weekday.slice(0, 1)}
          </abbr>
        ))}
        {days.map((day) => {
          const date = dateOf(day);
          const outside = date.getUTCMonth() !== first.getUTCMonth();
          const chosen = day === value;

          return (
            <button
              key={day}
              type="button"
              aria-label={spoken.format(date)}
              aria-pressed={chosen}
              disabled={Boolean(min && day < min)}
              onClick={() => {
                onChange(day);
                if (outside) go(date);
              }}
              className={`grid size-8 place-items-center rounded-lg text-[13px] tabular-nums transition-colors disabled:pointer-events-none disabled:opacity-30 ${
                chosen
                  ? 'bg-ink font-medium text-canvas'
                  : `hover:bg-glass-hover ${outside ? 'text-muted/60' : 'text-ink'} ${day === today ? 'font-semibold ring-1 ring-ink/25 ring-inset' : ''}`
              }`}
            >
              {date.getUTCDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

'use client';

import { Popover } from '@base-ui/react/popover';
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LOCALE } from '../../lib/format';

const pad = (value: number) => String(value).padStart(2, '0');
const hours = Array.from({ length: 24 }, (_, hour) => hour);
/** Five-minute steps: the ones people schedule by. A time off the grid still shows as chosen. */
const minutes = Array.from({ length: 12 }, (_, step) => step * 5);

/**
 * Hours beside minutes, each a column to click in, the chosen one in view as the popup opens.
 * `value` and the answer are `HH:mm`.
 */
function TimeColumns({
  value,
  onChange,
  chosenHour,
}: {
  value: string;
  onChange: (time: string) => void;
  /** Where the popup puts focus as it opens: on the chosen hour, not on 00. */
  chosenHour?: React.RefObject<HTMLButtonElement | null>;
}) {
  const [hour = 8, minute = 0] = value.split(':').map(Number);
  const columns = useRef<HTMLDivElement>(null);
  const shownMinutes = minutes.includes(minute)
    ? minutes
    : [...minutes, minute].sort((a, b) => a - b);

  // The chosen hour and minute in the middle of their columns. Only the columns scroll: moving
  // the dialog or the page under an open popup would pull the field away from it.
  // The popup lays itself out after it mounts, so the columns have no height at first: this
  // waits until they do, and centers again once the popup has placed focus.
  useEffect(() => {
    let frame = 0;
    const again = setTimeout(() => {
      frame = requestAnimationFrame(center);
    }, 60);
    const center = () => {
      const list = [...(columns.current?.querySelectorAll<HTMLElement>('.time-column') ?? [])];

      if (!list.length || list.some((column) => column.clientHeight === 0)) {
        frame = requestAnimationFrame(center);
        return;
      }

      for (const column of list) {
        const chosen = column.querySelector<HTMLElement>('[aria-pressed="true"]');

        if (chosen) {
          column.scrollTop = chosen.offsetTop - column.clientHeight / 2 + chosen.offsetHeight / 2;
        }
      }
    };

    frame = requestAnimationFrame(center);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(again);
    };
  }, []);

  return (
    <div className="time-columns" ref={columns}>
      <div className="time-column">
        <fieldset>
          <legend className="sr-only">Hour</legend>
          {hours.map((item) => (
            <button
              type="button"
              key={item}
              ref={item === hour ? chosenHour : undefined}
              aria-pressed={item === hour}
              onClick={() => onChange(`${pad(item)}:${pad(minute)}`)}
            >
              {pad(item)}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="time-column">
        <fieldset>
          <legend className="sr-only">Minute</legend>
          {shownMinutes.map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={item === minute}
              onClick={() => onChange(`${pad(hour)}:${pad(item)}`)}
            >
              {pad(item)}
            </button>
          ))}
        </fieldset>
      </div>
    </div>
  );
}

/** Where a popup belongs: inside the dialog its field is in, or the top layer hides it. */
function useContainer() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  return {
    trigger,
    container,
    locate: () => setContainer(trigger.current?.closest<HTMLElement>('dialog') ?? null),
  };
}

/** A time of day, `HH:mm`, picked from hour and minute columns. */
export function TimePicker({
  value,
  onChange,
  id,
  label,
}: {
  value: string;
  onChange: (time: string) => void;
  id?: string;
  label?: string;
}) {
  const { trigger, container, locate } = useContainer();
  const chosen = useRef<HTMLButtonElement>(null);

  return (
    <Popover.Root onOpenChange={(open) => open && locate()}>
      <Popover.Trigger ref={trigger} id={id} className="picker-trigger" aria-label={label}>
        <span>{value}</span>
        <Clock size={16} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal container={container ?? undefined}>
        <Popover.Positioner
          className="select-positioner"
          sideOffset={6}
          align="start"
          positionMethod="fixed"
        >
          <Popover.Popup className="picker-popup" initialFocus={chosen}>
            <TimeColumns value={value} onChange={onChange} chosenHour={chosen} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const weekdayLetters = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** The days of a month as a Monday-first grid, blanks before the first. */
function monthGrid(year: number, month: number) {
  const first = new Date(Date.UTC(year, month, 1));
  const blanks = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return [
    ...Array.from({ length: blanks }, () => null),
    ...Array.from({ length: days }, (_, index) => index + 1),
  ];
}

/**
 * A date and a time, `YYYY-MM-DDTHH:mm`, picked from a month calendar and the time columns.
 * Days before `min` cannot be chosen, since a schedule for the past never runs.
 */
export function DateTimePicker({
  value,
  onChange,
  min,
  id,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  /** `YYYY-MM-DD`: the first day that can be picked. */
  min?: string;
  id?: string;
  label?: string;
}) {
  const { trigger, container, locate } = useContainer();
  const chosen = useRef<HTMLButtonElement>(null);
  const [date = '', time = '08:00'] = value.split('T');
  const [year = 2026, month = 1, day = 1] = date.split('-').map(Number);
  const [shown, setShown] = useState({ year, month: month - 1 });
  const readable = new Intl.DateTimeFormat(LOCALE, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
  const move = (by: number) =>
    setShown(({ year: y, month: m }) => {
      const next = new Date(Date.UTC(y, m + by, 1));

      return { year: next.getUTCFullYear(), month: next.getUTCMonth() };
    });
  const iso = (d: number) => `${shown.year}-${pad(shown.month + 1)}-${pad(d)}`;

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!open) return;
        locate();
        setShown({ year, month: month - 1 });
      }}
    >
      <Popover.Trigger ref={trigger} id={id} className="picker-trigger" aria-label={label}>
        <span>
          {readable} · {time}
        </span>
        <CalendarDays size={16} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal container={container ?? undefined}>
        <Popover.Positioner
          className="select-positioner"
          sideOffset={6}
          align="start"
          positionMethod="fixed"
        >
          <Popover.Popup className="picker-popup calendar-popup" initialFocus={chosen}>
            <div className="calendar">
              <header>
                <button type="button" aria-label="Previous month" onClick={() => move(-1)}>
                  <ChevronLeft size={16} />
                </button>
                <strong>
                  {new Intl.DateTimeFormat(LOCALE, {
                    month: 'long',
                    year: 'numeric',
                    timeZone: 'UTC',
                  }).format(new Date(Date.UTC(shown.year, shown.month, 1)))}
                </strong>
                <button type="button" aria-label="Next month" onClick={() => move(1)}>
                  <ChevronRight size={16} />
                </button>
              </header>
              <div className="calendar-grid">
                {weekdayLetters.map((letter) => (
                  <span key={letter} className="calendar-weekday" aria-hidden="true">
                    {letter}
                  </span>
                ))}
                {monthGrid(shown.year, shown.month).map((item, index) =>
                  item === null ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: blanks are positions.
                    <span key={`blank-${index}`} />
                  ) : (
                    <button
                      type="button"
                      key={item}
                      aria-pressed={iso(item) === date}
                      disabled={Boolean(min && iso(item) < min)}
                      onClick={() => onChange(`${iso(item)}T${time}`)}
                    >
                      {item}
                    </button>
                  ),
                )}
              </div>
            </div>
            <TimeColumns
              value={time}
              onChange={(next) => onChange(`${date}T${next}`)}
              chosenHour={chosen}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

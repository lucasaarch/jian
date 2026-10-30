'use client';

import { useEffect, useRef } from 'react';

const pad = (value: number) => String(value).padStart(2, '0');

const hours = Array.from({ length: 24 }, (_, hour) => hour);
/** Minutes in fives, as times are usually set; one already set off the fives is kept. */
const fives = Array.from({ length: 12 }, (_, index) => index * 5);

/** The hour and the minute side by side, each a list scrolled to its choice when it opens. */
export function TimeColumns({
  value,
  onChange,
}: {
  /** HH:mm, or empty while no time is set. */
  value: string;
  onChange: (time: string) => void;
}) {
  const [hour, minute] = value ? value.split(':').map(Number) : [undefined, undefined];
  const minutes =
    minute === undefined || fives.includes(minute)
      ? fives
      : [...fives, minute].sort((a, b) => a - b);

  return (
    <div className="flex h-full gap-1">
      <Column
        label="Hour"
        values={hours}
        chosen={hour}
        pick={(next) => onChange(`${pad(next)}:${pad(minute ?? 0)}`)}
      />
      <Column
        label="Minute"
        values={minutes}
        chosen={minute}
        pick={(next) => onChange(`${pad(hour ?? 9)}:${pad(next)}`)}
      />
    </div>
  );
}

function Column({
  label,
  values,
  chosen,
  pick,
}: {
  label: string;
  values: number[];
  chosen: number | undefined;
  pick: (value: number) => void;
}) {
  const list = useRef<HTMLUListElement>(null);

  // On opening only: the choice in the middle, and the list left where the owner scrolls it.
  // Once the list has a height, which comes only after the panel it opens in is placed.
  useEffect(() => {
    const box = list.current;
    if (!box) return;
    const watch = new ResizeObserver(() => {
      if (!box.clientHeight) return;
      watch.disconnect();
      const current = box.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (current)
        box.scrollTop = current.offsetTop - (box.clientHeight - current.clientHeight) / 2;
    });
    watch.observe(box);
    return () => watch.disconnect();
  }, []);

  return (
    <ul
      ref={list}
      aria-label={label}
      className="relative grid h-full w-12 content-start gap-0.5 overflow-y-auto overscroll-contain [scrollbar-width:none]"
    >
      {values.map((value) => (
        <li key={value}>
          <button
            type="button"
            aria-label={`${label} ${pad(value)}`}
            aria-pressed={value === chosen}
            onClick={() => pick(value)}
            className={`grid h-8 w-full place-items-center rounded-lg text-[13px] tabular-nums transition-colors ${
              value === chosen ? 'bg-ink font-medium text-canvas' : 'text-ink hover:bg-glass-hover'
            }`}
          >
            {pad(value)}
          </button>
        </li>
      ))}
    </ul>
  );
}

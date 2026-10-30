'use client';

import { useQuery } from '@tanstack/react-query';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import { Skeleton } from '../../kit';
import type { ActivityDay, GatewayApi, Profile } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { card, Part } from './figures';

/** A year, laid out as the calendar lays it out: one column per week, Sunday at the top. */
const WEEKS = 53;
const DAYS = WEEKS * 7;

/** The day this date falls on where the reader is, which is the day the gateway counted. */
const iso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Seven rows, Sunday first: the row a day lands in is its weekday. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Half the tooltip's width: how close to an edge it may sit before it would be cut off. */
const TIP_REACH = 84;

/** Five steps of the ink, from nothing to the busiest day. */
const LEVELS = ['bg-ink/7', 'bg-ink/25', 'bg-ink/45', 'bg-ink/70', 'bg-ink'];

type Cell = { day: Date; runs: number; tokens: number; future: boolean };

/** The same sentence the tooltip shows, for a reader who is not using a pointer. */
const describe = (cell: Cell) =>
  cell.runs === 0
    ? 'No runs'
    : `${cell.runs.toLocaleString('en')} ${cell.runs === 1 ? 'run' : 'runs'} · ${cell.tokens.toLocaleString('en')} tokens`;

const longDate = (date: Date) =>
  date.toLocaleDateString('en', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/**
 * Five steps, cut from what this agent actually does rather than from fixed numbers: a gateway
 * answering ten times a day and one answering two hundred should both read as busy.
 */
function levelOf(runs: number, busiest: number): number {
  if (runs === 0) return 0;
  return Math.min(4, 1 + Math.floor(((runs - 1) / Math.max(busiest, 1)) * 4));
}

/** Every day of the window, ending this week, so the grid is complete where nothing happened. */
function calendar(days: Map<string, ActivityDay>): Cell[] {
  const today = new Date();
  const last = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // The grid ends on a full week, so the last column is not a ragged stub.
  last.setDate(last.getDate() + (6 - last.getDay()));

  return Array.from({ length: DAYS }, (_, index) => {
    const day = new Date(last);
    day.setDate(day.getDate() - (DAYS - 1 - index));
    const counted = days.get(iso(day));
    return {
      day,
      runs: counted?.runs ?? 0,
      tokens: counted?.tokens ?? 0,
      future: day > today,
    };
  });
}

/**
 * The agent's runs per day over the last year, in this browser's calendar. Until the days
 * arrive the empty year is its own skeleton: the same grid, every square at rest, pulsing.
 */
export function ActivityHeatmap({ profile, api }: { profile: Profile; api: GatewayApi }) {
  const query = useQuery({
    queryKey: keys.activityCalendar(profile.id, zone()),
    queryFn: () => api.activityCalendar(profile.id, zone()),
  });
  const days = query.data;
  const reading = !days && !query.error;
  const [hover, setHover] = useState<{ cell: Cell; x: number; y: number }>();
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  // The newest week sits at the right edge, so a page narrower than the year would open
  // showing last autumn and hide today.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, []);

  const counted = new Map((days ?? []).map((day) => [day.day, day]));
  const cells = calendar(counted);
  const busiest = Math.max(0, ...[...counted.values()].map((day) => day.runs));
  const total = [...counted.values()].reduce((sum, day) => sum + day.runs, 0);

  // One label per month, on the week its first day falls in. Keyed by the month and not by the
  // week: a month whose first days straddle two columns would otherwise be labelled twice.
  const months = cells.reduce<Array<{ month: number; week: number; label: string }>>(
    (labels, cell, index) => {
      const month = cell.day.getMonth();
      if (cell.day.getDate() <= 7 && labels.at(-1)?.month !== month) {
        labels.push({ month, week: Math.floor(index / 7), label: MONTHS[month] as string });
      }
      return labels;
    },
    [],
  );

  /**
   * Both rectangles are in viewport coordinates, so the difference stays correct however far
   * the calendar is scrolled sideways, and the tooltip never leaves the card it belongs to.
   */
  function follow(cell: Cell, event: MouseEvent<HTMLElement>) {
    const box = panel.current?.getBoundingClientRect();
    if (!box || cell.future) return;
    const square = event.currentTarget.getBoundingClientRect();
    const centre = square.left - box.left + square.width / 2;
    setHover({
      cell,
      x: Math.min(Math.max(centre, TIP_REACH), box.width - TIP_REACH),
      y: square.top - box.top,
    });
  }

  return (
    <Part
      title="Activity"
      action={
        days ? (
          <span className="text-xs text-muted">
            {`${total.toLocaleString('en')} runs in the last year`}
          </span>
        ) : (
          reading && <Skeleton className="h-3 w-36" />
        )
      }
    >
      {/* Outside the busy card, whose words a reader holds back until it is done. */}
      <p role="status" className="sr-only">
        {reading ? 'Loading activity…' : ''}
      </p>
      <div ref={panel} className={`${card} relative grid gap-3 p-4`} aria-busy={reading}>
        {query.error ? (
          <p role="alert" className="text-sm text-bad">
            {query.error instanceof Error ? query.error.message : 'Could not load.'}
          </p>
        ) : (
          <>
            <div ref={scroller} className="overflow-x-auto pb-1">
              <div className="grid w-max gap-1">
                <div
                  className="grid gap-[3px] text-[10px] text-muted"
                  style={{ gridTemplateColumns: `repeat(${WEEKS}, 0.6875rem)` }}
                  aria-hidden="true"
                >
                  {months.map((month) => (
                    <span key={month.month} style={{ gridColumnStart: month.week + 1 }}>
                      {month.label}
                    </span>
                  ))}
                </div>
                <table
                  className={`border-separate border-spacing-[3px] -m-[3px] ${reading ? 'motion-safe:animate-pulse' : ''}`}
                  onMouseLeave={() => setHover(undefined)}
                  aria-label="Runs per day"
                >
                  <tbody>
                    {WEEKDAYS.map((weekday, row) => (
                      <tr key={weekday}>
                        {Array.from({ length: WEEKS }, (_, week) => {
                          const cell = cells[week * 7 + row] as Cell;
                          return (
                            <td
                              key={iso(cell.day)}
                              className="p-0"
                              onMouseEnter={(event) => follow(cell, event)}
                              {...(cell.future
                                ? {}
                                : { 'aria-label': `${longDate(cell.day)}: ${describe(cell)}` })}
                            >
                              <span
                                className={`block size-[0.6875rem] rounded-[3px] ${cell.future ? 'bg-transparent' : LEVELS[levelOf(cell.runs, busiest)]}`}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {hover && (
              <div
                role="tooltip"
                className="glass pointer-events-none absolute z-10 grid -translate-x-1/2 -translate-y-[calc(100%+0.5rem)] gap-0.5 rounded-lg px-3 py-2 text-xs whitespace-nowrap"
                style={{ left: hover.x, top: hover.y }}
              >
                <strong className="font-medium text-ink">{longDate(hover.cell.day)}</strong>
                <span className="text-muted">{describe(hover.cell)}</span>
              </div>
            )}
            <footer
              className="flex items-center justify-end gap-1 text-[11px] text-muted"
              aria-hidden="true"
            >
              <span className="mr-1">Less</span>
              {LEVELS.map((tone) => (
                <span key={tone} className={`size-[0.6875rem] rounded-[3px] ${tone}`} />
              ))}
              <span className="ml-1">More</span>
            </footer>
          </>
        )}
      </div>
    </Part>
  );
}

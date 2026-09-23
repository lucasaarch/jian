'use client';

import { type MouseEvent, useEffect, useRef, useState } from 'react';
import type { ActivityDay, GatewayApi, Profile } from '../../lib/api';

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
 * Five steps, cut from what this profile actually does rather than from fixed numbers: a
 * gateway answering ten times a day and one answering two hundred should both read as busy.
 */
function levelOf(runs: number, busiest: number): number {
  if (runs === 0) {
    return 0;
  }

  return Math.min(4, 1 + Math.floor(((runs - 1) / Math.max(busiest, 1)) * 4));
}

/** Every day of the window, ending today, so the grid is complete even where nothing happened. */
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

export function ActivityHeatmap({ profile, api }: { profile: Profile; api: GatewayApi }) {
  const [days, setDays] = useState<ActivityDay[]>();
  const [error, setError] = useState('');
  const [hover, setHover] = useState<{ cell: Cell; x: number; y: number }>();
  const panel = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;

    api
      .activityCalendar(profile.id, zone())
      .then((calendarDays) => alive && setDays(calendarDays))
      .catch(
        (failure) =>
          alive && setError(failure instanceof Error ? failure.message : 'Could not load.'),
      );

    return () => {
      alive = false;
    };
  }, [api, profile.id]);

  // The newest week sits at the right edge, so a panel narrower than the year would open
  // showing last autumn and hide today.
  useEffect(() => {
    if (scroller.current) {
      scroller.current.scrollLeft = scroller.current.scrollWidth;
    }
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
   * the calendar is scrolled sideways, and the tooltip never leaves the panel it belongs to.
   */
  function follow(cell: Cell, event: MouseEvent<HTMLElement>) {
    const box = panel.current?.getBoundingClientRect();

    if (!box || cell.future) {
      return;
    }

    const square = event.currentTarget.getBoundingClientRect();
    const centre = square.left - box.left + square.width / 2;

    setHover({
      cell,
      x: Math.min(Math.max(centre, TIP_REACH), box.width - TIP_REACH),
      y: square.top - box.top,
    });
  }

  return (
    <section className="heatmap-panel" aria-label="Activity over the last year" ref={panel}>
      <header className="section-row">
        <div>
          <h2>Activity</h2>
          <p className="mt-1 text-sm">
            {days ? `${total.toLocaleString('en')} runs in the last year` : 'Loading…'}
          </p>
        </div>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <>
          <div className="heatmap-scroll" ref={scroller}>
            <div className="heatmap">
              <div
                className="heatmap-months"
                style={{ gridTemplateColumns: `repeat(${WEEKS}, 1fr)` }}
              >
                {months.map((month) => (
                  <span key={month.month} style={{ gridColumnStart: month.week + 1 }}>
                    {month.label}
                  </span>
                ))}
              </div>
              <table
                className="heatmap-grid"
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
                            onMouseEnter={(event) => follow(cell, event)}
                            {...(cell.future
                              ? {}
                              : { 'aria-label': `${longDate(cell.day)}: ${describe(cell)}` })}
                          >
                            <span
                              className={`heatmap-day level-${cell.future ? 'none' : levelOf(cell.runs, busiest)}`}
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
          {hover ? (
            <div className="heatmap-tip" role="tooltip" style={{ left: hover.x, top: hover.y }}>
              <strong>{longDate(hover.cell.day)}</strong>
              <span>{describe(hover.cell)}</span>
            </div>
          ) : null}
          <footer className="heatmap-legend">
            <span>Less</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span key={level} className={`heatmap-day level-${level}`} />
            ))}
            <span>More</span>
          </footer>
        </>
      )}
    </section>
  );
}

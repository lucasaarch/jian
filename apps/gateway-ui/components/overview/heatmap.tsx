'use client';

import { useEffect, useState } from 'react';
import type { ActivityDay, GatewayApi, Profile } from '../../lib/api';

/** A year, laid out as the calendar lays it out: one column per week, Sunday at the top. */
const WEEKS = 53;
const DAYS = WEEKS * 7;

const iso = (date: Date) => date.toISOString().slice(0, 10);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
function calendar(counts: Map<string, number>) {
  const today = new Date();
  const last = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));

  // The grid ends on a full week, so the last column is not a ragged stub.
  last.setUTCDate(last.getUTCDate() + (6 - last.getUTCDay()));

  return Array.from({ length: DAYS }, (_, index) => {
    const date = new Date(last);

    date.setUTCDate(date.getUTCDate() - (DAYS - 1 - index));

    const day = iso(date);

    return { day, date, runs: counts.get(day) ?? 0, future: date > today };
  });
}

export function ActivityHeatmap({ profile, api }: { profile: Profile; api: GatewayApi }) {
  const [days, setDays] = useState<ActivityDay[]>();
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;

    api
      .activityCalendar(profile.id)
      .then((calendarDays) => alive && setDays(calendarDays))
      .catch(
        (failure) =>
          alive && setError(failure instanceof Error ? failure.message : 'Could not load.'),
      );

    return () => {
      alive = false;
    };
  }, [api, profile.id]);

  const counts = new Map((days ?? []).map((day) => [day.day, day.runs]));
  const cells = calendar(counts);
  const busiest = Math.max(0, ...counts.values());
  const total = [...counts.values()].reduce((sum, runs) => sum + runs, 0);

  // One label per month, placed on the week where that month first appears.
  const months = cells.reduce<Array<{ week: number; label: string }>>((labels, cell, index) => {
    const week = Math.floor(index / 7);

    if (cell.date.getUTCDate() <= 7 && !labels.some((label) => label.week === week)) {
      labels.push({ week, label: MONTHS[cell.date.getUTCMonth()] as string });
    }

    return labels;
  }, []);

  return (
    <section className="heatmap-panel" aria-label="Activity over the last year">
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
          <div className="heatmap-scroll">
            <div className="heatmap">
              <div
                className="heatmap-months"
                style={{ gridTemplateColumns: `repeat(${WEEKS}, 1fr)` }}
              >
                {months.map((month) => (
                  <span key={month.week} style={{ gridColumnStart: month.week + 1 }}>
                    {month.label}
                  </span>
                ))}
              </div>
              <div
                className="heatmap-grid"
                style={{ gridTemplateColumns: `repeat(${WEEKS}, 1fr)` }}
              >
                {cells.map((cell) => (
                  <span
                    key={cell.day}
                    className={`heatmap-day level-${cell.future ? 'none' : levelOf(cell.runs, busiest)}`}
                    title={
                      cell.future
                        ? cell.day
                        : `${cell.day} · ${cell.runs} ${cell.runs === 1 ? 'run' : 'runs'}`
                    }
                  />
                ))}
              </div>
            </div>
          </div>
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

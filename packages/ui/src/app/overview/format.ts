import { LOCALE } from '../../lib/format';

/** A count as a dashboard writes it: 950, 12.4k, 196.7M, 12.0B. */
export const compact = (value: number) =>
  value < 1000
    ? Math.round(value).toLocaleString(LOCALE)
    : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

/** Dollars, with cents below a thousand and without them above. */
export const money = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1000 ? 2 : 0,
    minimumFractionDigits: value < 1000 ? 2 : 0,
  }).format(value);

/** How long, in the two largest units that say it: 1d 15h, 3h 20m, 12m, under a minute. */
export function duration(ms: number) {
  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) return ms > 0 ? '<1m' : '0m';

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;

  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${rest}m`;

  return `${rest}m`;
}

export const percent = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 100)}%` : '0%';

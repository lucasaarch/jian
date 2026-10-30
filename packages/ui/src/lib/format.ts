/** How the panel writes values a person reads. Internationalization replaces the locale here. */

/**
 * The panel speaks English whatever the browser's language: British, for the 24-hour clock the
 * rest of the panel writes times in.
 */
export const LOCALE = 'en-GB';

export const date = (value?: string) =>
  value
    ? new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';

/**
 * `owner/repo` for a GitHub address, over HTTPS or SSH, with or without `.git`: how a project's
 * repository is named in a list. Any other address is shown whole.
 */
export function repositorySlug(url: string): string {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);

  return match ? `${match[1]}/${match[2]}` : url;
}

/**
 * How long ago, in the fewest characters a list can carry: `now`, `5m`, `6h`, `9d`, `3w`, then
 * the date. Past four weeks a count of weeks says less than the day itself.
 */
export function ago(value: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 28) return `${Math.floor(days / 7)}w`;
  return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' }).format(
    new Date(value),
  );
}

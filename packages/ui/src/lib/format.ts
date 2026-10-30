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

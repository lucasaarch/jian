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

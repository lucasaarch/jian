/**
 * The settings page an address opens: `''` for `/settings` alone, the page's id for
 * `/settings/:page`, undefined anywhere else.
 */
export function settingsOf(pathname: string): string | undefined {
  const match = /^\/settings(?:\/([^/]+))?\/?$/.exec(pathname);
  return match ? (match[1] ?? '') : undefined;
}

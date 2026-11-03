/**
 * Settings pages that moved, by their old address: one bookmarked, or sent back by a gateway,
 * still opens them. `integrations` became Apps, and stays readable for good: it is the return
 * address GitHub and X send the owner back to, which every gateway, old or new, accepts.
 */
const MOVED: Record<string, string> = { integrations: 'apps' };

/**
 * The settings page an address opens: `''` for `/settings` alone, the page's id for
 * `/settings/:page`, undefined anywhere else. A moved page opens where it is now, and so does
 * the GitHub details address under it, `/settings/integrations/github`.
 */
export function settingsOf(pathname: string): string | undefined {
  const match = /^\/settings(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(pathname);
  if (!match) return undefined;
  const [, page = '', below] = match;
  const moved = MOVED[page];
  if (moved) return moved;
  return below === undefined ? page : undefined;
}

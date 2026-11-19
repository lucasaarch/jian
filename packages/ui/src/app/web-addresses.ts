/**
 * Settings pages that left for Plugins, by their old addresses: Apps, MCP servers, and
 * Integrations before them. The last stays readable for good: it is the return address GitHub
 * and X send the owner back to, which every gateway, old or new, accepts.
 */
const PLUGINS = ['apps', 'mcp-servers', 'integrations'];

/**
 * Whether an address is one of the settings pages that became Plugins, with anything under it,
 * such as the GitHub details address `/settings/integrations/github`. It names no agent: the
 * chats send it on to the Plugins of the agent in use, query and all.
 */
export const movedToPlugins = (pathname: string) =>
  PLUGINS.includes(/^\/settings\/([^/]+)(?:\/|$)/.exec(pathname)?.[1] ?? '');

/**
 * The connector GitHub or X sent the owner back for, by the outcome each leaves in the query:
 * `?github=` or `?x=`. Its own page is where that outcome is said.
 */
export const returnedConnector = (params: URLSearchParams) =>
  params.has('github') ? 'github' : params.has('x') ? 'x' : undefined;

/**
 * The settings page an address opens: `''` for `/settings` alone, the page's id for
 * `/settings/:page`, undefined anywhere else. A page that moved to Plugins is no longer one of
 * Settings', so its address opens nothing here.
 */
export function settingsOf(pathname: string): string | undefined {
  const match = /^\/settings(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match || movedToPlugins(pathname)) return undefined;
  return match[1] ?? '';
}

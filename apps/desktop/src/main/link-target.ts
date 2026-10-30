import { LOCAL_GATEWAY_ID, type OpenTarget } from '../shared/bridge';

/**
 * `jian://open/<path>?<query>` from outside the app: the page the local gateway shows after a
 * GitHub sign-in links back with it. The window opens there, on the app's own gateway, which
 * is the only one whose pages link back this way.
 */
export function linkTarget(link: string): OpenTarget | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'jian:' || url.hostname !== 'open') return undefined;
  const path = `${url.pathname || '/'}${url.search}`;
  // A place in the panel, never another origin: `//host` would read as one in a browser.
  if (!path.startsWith('/') || path.startsWith('//')) return undefined;
  return { gatewayId: LOCAL_GATEWAY_ID, path };
}

/** The jian:// link a second launch was asked to open, on Windows and Linux. */
export const linkIn = (argv: readonly string[]) => argv.find((arg) => arg.startsWith('jian://'));

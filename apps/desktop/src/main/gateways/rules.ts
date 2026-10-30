/**
 * What makes a gateway usable from this app, in rules with no Electron in them: the address the
 * owner typed, and whether the gateway's release speaks the same API as the panel built in here.
 */

/**
 * The gateway's address without a trailing slash, or an error to show. HTTP stays allowed: a
 * gateway on the LAN or this machine is a supported self-hosted setup, as on the web.
 */
export function parseGatewayUrl(input: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { error: 'Enter the full address, starting with https:// or http://.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'The address must start with https:// or http://.' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { error: 'Enter the address alone, without a user, a query or a #fragment.' };
  }
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` };
}

const RELEASE = /^(\d+)\.(\d+)\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** major.minor of a published release; undefined for a development build, which is never compared. */
export function releaseLine(version: string | undefined): string | undefined {
  const match = RELEASE.exec(version?.replace(/^v/, '') ?? '');
  if (!match || version === '0.0.0-dev') return undefined;
  return `${match[1]}.${match[2]}`;
}

/**
 * The panel inside the app reads a gateway's answers as its own release writes them. Releases
 * keep that shape within a major.minor; across lines the app shows the mismatch instead.
 */
export function compatible(appVersion: string, gatewayVersion: string | undefined): boolean {
  const app = releaseLine(appVersion);
  const gateway = releaseLine(gatewayVersion);
  return !app || !gateway || app === gateway;
}

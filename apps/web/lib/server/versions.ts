import { gatewayUrl } from './gateway';

const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** How long the gateway's version is trusted before a page asks again. */
const KEPT_MS = 30_000;
/** A gateway slower than this is the panel's other errors to report, not a version to compare. */
const TIMEOUT_MS = 2_000;

/** A published release, or nothing: a local build carries no version and is never compared. */
export function release(value: string | undefined) {
  const version = value?.replace(/^v/, '');
  return version && RELEASE.test(version) && version !== '0.0.0-dev' ? version : undefined;
}

let known: { at: number; version: string | undefined } | undefined;

/** The gateway's release as its health answers, kept a little; undefined when it cannot say. */
async function gatewayRelease(now = Date.now()) {
  if (known && now - known.at < KEPT_MS) return known.version;
  try {
    const response = await fetch(`${gatewayUrl()}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const { version } = (await response.json()) as { version?: string };
    known = { at: now, version: release(version) };
    return known.version;
  } catch {
    return undefined;
  }
}

/**
 * The panel and the gateway it fronts, when they are different releases. The panel speaks the
 * gateway's API as its own release does; another release may answer in shapes it does not know,
 * so it shows nothing but the mismatch rather than half-working screens.
 */
export async function versionMismatch(): Promise<{ web: string; gateway: string } | undefined> {
  const web = release(process.env.JIAN_VERSION);
  if (!web) return undefined;
  const gateway = await gatewayRelease();
  return gateway && gateway !== web ? { web, gateway } : undefined;
}

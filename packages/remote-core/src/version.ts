const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** A published release, read apart. */
export type Release = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | undefined;
  raw: string;
};

/** Whether a worker of one release may talk to a gateway of another, and why not. */
export type Compatibility =
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; local: string; gateway: string }
  | {
      ok: false;
      skipped: false;
      local: string;
      gateway: string;
      required: string;
      message: string;
    };

export function parseRelease(version: unknown): Release | null {
  const raw = typeof version === 'string' ? version.replace(/^v/, '').trim() : '';
  const match = SEMVER.exec(raw);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    raw,
  };
}

export function isDevVersion(version: unknown): boolean {
  const raw = typeof version === 'string' ? version.replace(/^v/, '').trim() : '';
  return !raw || raw === '0.0.0-dev' || raw === '0.0.0';
}

/**
 * Rule: a released remote-control may talk to a released gateway only when major.minor match
 * (patch and prerelease may differ). A gateway with no version (local `make dev`) skips the
 * gate so developers are not blocked. A released gateway rejects a dev/unknown worker.
 */
export function versionsCompatible(
  localVersion: string | undefined,
  gatewayVersion: string | undefined,
): Compatibility {
  if (isDevVersion(gatewayVersion)) {
    return { ok: true, skipped: true };
  }
  const gateway = parseRelease(gatewayVersion);
  if (!gateway) return { ok: true, skipped: true };

  if (isDevVersion(localVersion)) {
    return {
      ok: false,
      skipped: false,
      local: localVersion ?? 'unknown',
      gateway: gateway.raw,
      required: `${gateway.major}.${gateway.minor}`,
      message: `This remote-control build (${localVersion ?? 'unknown'}) is not a released package and cannot connect to gateway ${gateway.raw}. Install a matching release: jian-remote update --version ${gateway.raw}`,
    };
  }
  const local = parseRelease(localVersion);
  if (!local) {
    return {
      ok: false,
      skipped: false,
      local: localVersion ?? 'unknown',
      gateway: gateway.raw,
      required: `${gateway.major}.${gateway.minor}`,
      message: `This remote-control version (${localVersion ?? 'unknown'}) is not a valid release and cannot connect to gateway ${gateway.raw}.`,
    };
  }
  if (local.major === gateway.major && local.minor === gateway.minor) {
    return { ok: true, skipped: false, local: local.raw, gateway: gateway.raw };
  }
  return {
    ok: false,
    skipped: false,
    local: local.raw,
    gateway: gateway.raw,
    required: `${gateway.major}.${gateway.minor}`,
    message: `This remote-control ${local.raw} is incompatible with gateway ${gateway.raw}. Jian requires the same major.minor (${gateway.major}.${gateway.minor}). Connected workers try to self-update to the gateway version automatically; if that fails, run: jian-remote update --version ${gateway.raw}`,
  };
}

export function compatibilityError(
  localVersion: string | undefined,
  gatewayVersion: string | undefined,
): string | null {
  const result = versionsCompatible(localVersion, gatewayVersion);
  return result.ok ? null : result.message;
}

/**
 * True when the worker should self-update so its PACKAGE_VERSION matches the gateway release.
 * Covers patch bumps and major.minor skew (fleet upgrade to the gateway’s version). Dev /
 * unversioned gateways never force a match.
 */
export function shouldMatchGatewayVersion(
  localVersion: string | undefined,
  gatewayVersion: string | undefined,
): boolean {
  if (isDevVersion(gatewayVersion)) return false;
  const gateway = parseRelease(gatewayVersion);
  if (!gateway) return false;
  if (isDevVersion(localVersion)) return true;
  const local = parseRelease(localVersion);
  if (!local) return true;
  return local.raw !== gateway.raw;
}

/** Soft ceiling so a failed fleet update does not KeepAlive-spin every few seconds. */
export function nextUpdateBackoffMs(failureCount: unknown): number {
  const n = Math.max(0, Number(failureCount) || 0);
  // 5s, 10s, … then cap at 30 minutes (2^9 * 5s = 2560s > 30m).
  return Math.min(30 * 60_000, 5_000 * 2 ** Math.min(n, 9));
}

/** Public /health carries the gateway release so install/update can gate without a worker token. */
export async function fetchGatewayVersion(
  gatewayBase: string,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetcher(`${gatewayBase.replace(/\/$/, '')}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Could not read gateway version: HTTP ${response.status}`);
  const body = (await response.json()) as { version?: unknown } | null;
  const version = body?.version;
  return typeof version === 'string' && version.trim() ? version.trim() : undefined;
}

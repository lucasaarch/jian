const RELEASE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The release this gateway runs, as its image stamped it in JIAN_VERSION. A gateway run from
 * source has none: it reports no version and holds no worker to one.
 */
export function gatewayRelease(stamp = process.env.JIAN_VERSION): string | undefined {
  const version = stamp?.trim().replace(/^v/, '');
  return version && RELEASE.test(version) && version !== '0.0.0-dev' ? version : undefined;
}

/**
 * Whether a worker of `worker` may not serve agents on a gateway of `gateway`: they must share
 * major.minor. A gateway with no release holds nobody back, and a worker that has not said
 * its release yet is not judged; a development or malformed worker never matches a release.
 */
export function workerOutdated(worker: string | null, gateway: string | undefined): boolean {
  if (!gateway || worker === null) return false;
  const want = RELEASE.exec(gateway);
  const have = RELEASE.exec(worker.trim().replace(/^v/, ''));
  if (!want || !have) return true;
  return have[1] !== want[1] || have[2] !== want[2];
}

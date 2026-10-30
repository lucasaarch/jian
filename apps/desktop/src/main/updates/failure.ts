import type { UpdateFailure } from '../../shared/updates';

/** Node's and Chromium's words for a network that is not there. */
const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);
const OFFLINE =
  /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|ADDRESS_UNREACHABLE|TIMED_OUT|CONNECTION_\w+|PROXY_CONNECTION_FAILED)|getaddrinfo/;

/**
 * electron-updater's codes when a release has no update files for this system: the tag exists
 * and its assets are still uploading, or this platform's build failed and was left out.
 */
const MISSING_CODES = new Set([
  'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
  'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
  'ERR_UPDATER_RELEASE_NOT_FOUND',
  'ERR_UPDATER_ASSET_NOT_FOUND',
  'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
  'ERR_UPDATER_NO_FILES_PROVIDED',
]);
const MISSING = /Cannot find [\w.-]*\.yml|Cannot find latest|HttpError: 404/;

/**
 * Integrity: the sha512 the metadata names (every OS), the publisher Windows checks once the app
 * is signed, and the code signature Squirrel.Mac checks before it accepts a bundle.
 */
const SIGNATURE =
  /checksum mismatch|not signed by the application owner|code signature|did not pass validation|failed to satisfy specified code requirement|SQRLCodeSignature/i;

/** Squirrel.Mac refuses to replace an app run from its disk image or a translocated copy. */
const READ_ONLY = /read-only volume|translocat/i;

/** The first line of what the updater said, short enough to show. */
function firstLine(message: string): string {
  const line = message.split('\n').find((part) => part.trim()) ?? '';
  return line.trim().slice(0, 240);
}

/** What kind of failure an updater error is, and its own words for it. */
export function failureOf(error: unknown): { failure: UpdateFailure; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined;
  const detail = firstLine(message);
  if (code && MISSING_CODES.has(code)) return { failure: 'missing', detail };
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE' || SIGNATURE.test(message)) {
    return { failure: 'signature', detail };
  }
  if (READ_ONLY.test(message)) return { failure: 'read-only', detail };
  if ((code && OFFLINE_CODES.has(code)) || OFFLINE.test(message)) {
    return { failure: 'offline', detail };
  }
  if (MISSING.test(message)) return { failure: 'missing', detail };
  return { failure: 'unknown', detail };
}

import { createHash, randomBytes } from 'node:crypto';

export const DEVICE_TOKEN_PREFIX = 'jdev_';

/** Hex SHA-256. Secrets here are random and long, so a fast hash is enough to keep them unreadable. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** The token is shown to the phone once; only its hash is stored. */
export function newDeviceToken(): { token: string; hash: string } {
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashSecret(token) };
}

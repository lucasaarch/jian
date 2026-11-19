import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * The password a public Artifact's link asks for, and the pass a reader holds once they typed it.
 *
 * The password is kept only as a salted scrypt hash. A pass is a time it runs out and a signature
 * of the link's token and that time, keyed with the hash itself: no secret of the gateway's is
 * needed, and a new password, or a new link, ends every pass given before without anything kept.
 */

const SCHEME = 'scrypt';
const KEY_LENGTH = 32;

/** How long a reader stays in after typing the password: a day. */
export const PASS_SECONDS = 24 * 60 * 60;

const derive = (password: string, salt: Buffer, length: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, length, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );

/** What is kept for a password: `scrypt$<salt>$<hash>`, both base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, KEY_LENGTH);

  return `${SCHEME}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function passwordMatches(password: string, kept: string): Promise<boolean> {
  const [scheme, salt, hash] = kept.split('$');
  if (scheme !== SCHEME || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const given = await derive(password, Buffer.from(salt, 'base64url'), expected.length);

  return timingSafeEqual(given, expected);
}

const signature = (token: string, kept: string, expires: number) =>
  createHmac('sha256', kept).update(`${token}.${expires}`).digest('base64url');

/** A pass to the link `token` while its password is `kept`, from `now` (milliseconds). */
export function issuePass(token: string, kept: string, now: number): string {
  const expires = Math.floor(now / 1000) + PASS_SECONDS;

  return `${expires}.${signature(token, kept, expires)}`;
}

/** Whether `pass` still opens the link `token`, whose password is `kept`. */
export function passOpens(
  token: string,
  kept: string,
  pass: string | undefined,
  now: number,
): boolean {
  const [expires, signed] = (pass ?? '').split('.');
  const at = Number(expires);
  if (!signed || !Number.isSafeInteger(at) || at * 1000 <= now) return false;
  const expected = Buffer.from(signature(token, kept, at));
  const given = Buffer.from(signed);

  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The cookie a link's pass is kept in, named after the link so several stay open at once. It
 * has no `Path`: the browser scopes it to the folder of the address the form posted to, which
 * holds the link and its downloads also when the gateway stands behind a path of a proxy's.
 */
const cookieName = (token: string) =>
  `jian_artifact_${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;

export function passCookie(token: string, pass: string, secure: boolean): string {
  return [
    `${cookieName(token)}=${pass}`,
    `Max-Age=${PASS_SECONDS}`,
    'HttpOnly',
    // Sent when the link is opened from anywhere, as a link is; never with another site's form.
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The pass this request carries for the link `token`, if any. */
export function passOf(cookie: string | undefined, token: string): string | undefined {
  if (!cookie || cookie.length > 8192) return undefined;
  const name = cookieName(token);

  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }

  return undefined;
}

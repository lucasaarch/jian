import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a signed timestamp may be from now, in seconds: a replayed payload is refused. */
const TOLERANCE_S = 5 * 60;

type Headers = Readonly<Record<string, string | string[] | undefined>>;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Whether a webhook was signed with `secret` the way Svix signs, which is how Resend delivers
 * its events: `v1,<base64 HMAC-SHA256>` over `<id>.<timestamp>.<body>`, keyed with the base64
 * secret after its `whsec_` prefix. The body must be the bytes as they arrived, never JSON
 * parsed and written again. Several signatures may be listed while a secret rotates; any one
 * of them is enough.
 */
export function svixSigned(
  raw: Buffer,
  headers: Headers,
  secret: string,
  now: number = Date.now(),
): boolean {
  const id = one(headers['svix-id']);
  const timestamp = one(headers['svix-timestamp']);
  const signatures = one(headers['svix-signature']);

  if (!id || !timestamp || !signatures || id.length > 200 || signatures.length > 2000) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_S) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  if (!key.length) return false;

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest();

  return signatures.split(' ').some((entry) => {
    const [version, signature] = entry.split(',');
    if (version !== 'v1' || !signature) return false;
    const given = Buffer.from(signature, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

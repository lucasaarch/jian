import { z } from 'zod';

/**
 * A secret is typed where the thing that uses it is configured, and never read back: the
 * gateway encrypts it per profile and the record only shows that it exists.
 */
export const credentialSchema = z.string().min(1).max(16000).meta({ writeOnly: true });

/**
 * The panel signs in once with the host token and then rides a signed, HttpOnly cookie, so the
 * token itself never reaches browser storage and no script can read the session back.
 */
export const panelSessionInputSchema = z.strictObject({
  token: z.string().min(32).max(512).meta({ writeOnly: true }),
});

export const panelSessionSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
});

export const panelSessionEndSchema = z.strictObject({ ended: z.literal(true) });

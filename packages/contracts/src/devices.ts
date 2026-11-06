import { z } from 'zod';

/**
 * Phones paired to the gateway. A device acts with the owner's access, so nothing here carries a
 * token after pairing: the device token is returned once, and the push token is only ever
 * reported as set or not.
 */

const nameSchema = z.string().min(1).max(60);
const platformSchema = z.enum(['ios', 'android']);

export const deviceSchema = z.strictObject({
  id: z.uuid(),
  name: nameSchema,
  platform: platformSchema,
  // Whether notifications show message text; off shows only that something happened.
  previews: z.boolean(),
  // A push token is set. The token itself is never served.
  push: z.boolean(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
});

/**
 * What the QR code encodes: the address phones reach the gateway at, and a single-use code.
 * `expiresIn` is whole seconds from this answer; a countdown runs from it, since `expiresAt` is
 * on the gateway's clock and the browser's may be minutes off.
 */
export const devicePairingSchema = z.strictObject({
  url: z.string(),
  code: z.string(),
  expiresAt: z.iso.datetime(),
  expiresIn: z.number().int().min(0),
});

export const devicePairInputSchema = z.strictObject({
  code: z.string().min(1).max(64),
  name: nameSchema,
  platform: platformSchema,
});

/** The only response that carries a device token; it cannot be read again. */
export const devicePairedSchema = z.strictObject({
  device: deviceSchema,
  token: z.string(),
});

export const devicePatchSchema = z
  .strictObject({
    name: nameSchema.optional(),
    previews: z.boolean().optional(),
  })
  .refine((patch) => patch.name !== undefined || patch.previews !== undefined, {
    message: 'Send a name or previews to change.',
  });

export const devicePushInputSchema = z.strictObject({
  pushToken: z.string().min(1).max(200).nullable(),
});

export const deviceFocusInputSchema = z.strictObject({
  sessionId: z.uuid().nullable(),
});

export type Device = z.infer<typeof deviceSchema>;
export type DevicePairing = z.infer<typeof devicePairingSchema>;
export type DevicePaired = z.infer<typeof devicePairedSchema>;

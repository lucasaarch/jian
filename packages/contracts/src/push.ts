import { z } from 'zod';

/**
 * A browser or installed app that may show the owner's notifications, as its push service
 * names it: where to send, and the keys each message is sealed with for it alone.
 */
export const pushSubscriptionInputSchema = z.strictObject({
  // A push service is reached over HTTPS only; anything else is not one.
  endpoint: z.url({ protocol: /^https$/ }).max(2000),
  keys: z.strictObject({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
});

export const pushEndpointSchema = z.strictObject({ endpoint: z.url().max(2000) });

/** The installation's public key, which a browser needs to subscribe. */
export const pushKeySchema = z.strictObject({ publicKey: z.string() });

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;

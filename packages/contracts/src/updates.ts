import { z } from 'zod';

/** The two images a server installation runs, deployed apart on most platforms. */
export const updateComponentSchema = z.enum(['gateway', 'web']);

export const updateWebhookMethodSchema = z.enum(['POST', 'PUT', 'PATCH', 'GET']);

const pairSchema = z.strictObject({
  // An HTTP token: what a header name may be, and plenty for a query parameter's.
  name: z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/),
  // No line breaks: a header value cannot hold one, and a parameter has no need to.
  value: z
    .string()
    .max(2000)
    .regex(/^[^\r\n]*$/),
});

/**
 * A redeploy webhook of the platform the owner runs Jian on (Dokploy, Coolify, Portainer,
 * Cubeship…), sent exactly as configured. `{version}` (the release being installed, such as
 * `1.13.0`) and `{component}` (`gateway` or `web`) are filled in the URL, the parameter and
 * header values and the body, since a platform caching `latest` would redeploy what it runs.
 */
export const updateWebhookInputSchema = z.strictObject({
  // Not `z.url()`: the braces of `{version}` are not valid in a URI until they are filled.
  url: z
    .string()
    .max(2000)
    .regex(/^https?:\/\/[^\s/?#]+\S*$/i),
  method: updateWebhookMethodSchema.default('POST'),
  params: z
    .array(pairSchema)
    .max(20)
    .default([])
    .describe('Query parameters, encoded and added to any query the URL already has.'),
  headers: z.array(pairSchema).max(20).default([]),
  body: z
    .string()
    .max(8000)
    .optional()
    .describe('Sent as it is, once filled; empty sends no body. Not allowed with GET.'),
});

/**
 * What the panel may see of a saved webhook. Its path, parameter values and header values may
 * all hold the platform's secret, so only their names come back.
 */
export const updateWebhookSchema = z.strictObject({
  origin: z.string(),
  method: updateWebhookMethodSchema,
  params: z.array(z.string()),
  headers: z.array(z.string()),
  body: z.boolean(),
  updatedAt: z.iso.datetime(),
});

export const updateResultSchema = z.strictObject({
  component: updateComponentSchema,
  ok: z.boolean(),
  /** HTTP status the platform or the updater answered. */
  status: z.number().int().optional(),
  error: z.string().optional(),
});

export const updateAttemptSchema = z.strictObject({
  at: z.iso.datetime(),
  from: z.string().optional(),
  version: z.string(),
  method: z.enum(['webhook', 'sidecar']),
  ok: z.boolean(),
  results: z.array(updateResultSchema),
});

export const updateStatusSchema = z.strictObject({
  /** Absent on a build with no version stamped on it. */
  current: z.string().optional(),
  latest: z
    .strictObject({ version: z.string(), date: z.string(), body: z.string() })
    .optional()
    .describe('The newest stable release above the running one, when GitHub could be reached.'),
  /** When GitHub last answered the releases read; absent before the first one. */
  checkedAt: z.iso.datetime().optional(),
  /** Why the latest read of GitHub failed; `latest` still holds what it said before. */
  checkError: z.string().optional(),
  /** A release on the way says to back up first, or that it drops data. */
  backup: z.boolean(),
  /** How an update is carried out: the compose updater wins over webhooks when both exist. */
  method: z.enum(['none', 'webhook', 'sidecar']),
  webhooks: z.strictObject({
    gateway: updateWebhookSchema.optional(),
    web: updateWebhookSchema.optional(),
  }),
  attempts: z.array(updateAttemptSchema),
});

export const updateInputSchema = z.strictObject({
  /** The release the owner saw; refused when it is no longer the newest. */
  version: z.string().max(64),
  /** Required when `backup` is true. */
  confirmBackup: z.boolean().optional(),
});

export type UpdateComponent = z.infer<typeof updateComponentSchema>;
export type UpdateWebhookInput = z.input<typeof updateWebhookInputSchema>;
export type UpdateWebhookMethod = z.infer<typeof updateWebhookMethodSchema>;
export type UpdateWebhook = z.infer<typeof updateWebhookSchema>;
export type UpdateResult = z.infer<typeof updateResultSchema>;
export type UpdateAttempt = z.infer<typeof updateAttemptSchema>;
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

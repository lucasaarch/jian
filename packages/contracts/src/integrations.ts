import { z } from 'zod';

export const githubIntegrationAccountSchema = z.strictObject({
  id: z.uuid(),
  installationId: z.number().int().positive().safe(),
  accountId: z.number().int().positive().safe(),
  login: z.string().min(1).max(100),
  type: z.enum(['User', 'Organization']),
  avatarUrl: z.url().optional(),
  connectedAt: z.iso.datetime(),
});

export const githubIntegrationStatusSchema = z.strictObject({
  configured: z.boolean(),
  permissionsVerified: z.boolean().optional(),
  missingPermissions: z.array(z.string()).optional(),
  app: z
    .strictObject({
      appId: z.number().int().positive().safe(),
      name: z.string().min(1),
      slug: z.string().min(1),
      ownerLogin: z.string().min(1).optional(),
      ownerType: z.enum(['User', 'Organization']).optional(),
      url: z.url(),
    })
    .optional(),
  callbackUrl: z.url().optional(),
  accounts: z.array(githubIntegrationAccountSchema),
});

export const githubInstallSchema = z.strictObject({ url: z.url() });
/**
 * Where GitHub sends the owner back: the gateway's Apps page, or its GitHub details. The gateway
 * redirects to it, so it is one of those two panel paths and nothing else — never another origin.
 * They are the old Integrations addresses and stay so for good: both hosts open them as Apps, and
 * a panel and a gateway of different versions still agree on them.
 */
export const githubReturnPathSchema = z.enum([
  '/settings/integrations',
  '/settings/integrations/github',
]);
export const githubInstallInputSchema = z.strictObject({ returnPath: githubReturnPathSchema });
export const githubManifestSchema = z.strictObject({
  state: z.string().min(1),
  action: z.url(),
  manifest: z.record(z.string(), z.unknown()),
});

export const githubRepositorySchema = z.strictObject({
  id: z.number().int().positive().safe(),
  name: z.string().min(1).max(100),
  fullName: z.string().min(1).max(200),
  ownerLogin: z.string().min(1).max(100),
  private: z.boolean(),
  htmlUrl: z.url(),
  cloneUrl: z.url(),
  defaultBranch: z.string().max(255).optional(),
  description: z.string().max(1000).optional(),
});

/** A repository with the connected account it comes through, so one list can mix accounts. */
export const githubConnectedRepositorySchema = githubRepositorySchema.extend({
  accountId: z.uuid(),
});

export type GitHubIntegrationAccount = z.infer<typeof githubIntegrationAccountSchema>;
export type GitHubRepository = z.infer<typeof githubRepositorySchema>;
export type GitHubConnectedRepository = z.infer<typeof githubConnectedRepositorySchema>;

export const xAccountStatusSchema = z.enum(['connected', 'needs_attention']);

export const xAccountSchema = z.strictObject({
  id: z.uuid(),
  userId: z.string().min(1),
  handle: z.string().min(1),
  name: z.string(),
  status: xAccountStatusSchema,
  /** What the gateway asks of an account today and this one was not granted. */
  missingScopes: z.array(z.string()),
  connectedAt: z.iso.datetime(),
});

/** The client secret is never here: `configured` is all the panel learns of it. */
export const xIntegrationStatusSchema = z.strictObject({
  configured: z.boolean(),
  clientId: z.string().optional(),
  callbackUrl: z.url().optional(),
  accounts: z.array(xAccountSchema),
});

export const xAppInputSchema = z.strictObject({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().trim().min(1).max(500),
});

export const xConnectSchema = z.strictObject({ url: z.url() });

export type XIntegrationStatus = z.infer<typeof xIntegrationStatusSchema>;

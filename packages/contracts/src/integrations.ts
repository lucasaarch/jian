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
export const githubInstallInputSchema = z.strictObject({
  returnPath: z.enum([
    '/integrations',
    '/ui/integrations',
    '/integrations/github',
    '/ui/integrations/github',
  ]),
});
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

export type GitHubIntegrationAccount = z.infer<typeof githubIntegrationAccountSchema>;
export type GitHubRepository = z.infer<typeof githubRepositorySchema>;

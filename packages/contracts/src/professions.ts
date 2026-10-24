import { z } from 'zod';

/** Stable product IDs, not mutable identity text. Activation is a separate rollout step. */
export const professionIdSchema = z.enum(['developer', 'attendant']);
export type ProfessionId = z.infer<typeof professionIdSchema>;

/** Semantic authority; tool groups are only a presentation/loading mechanism. */
export const capabilitySchema = z.enum([
  'conversation.control',
  'conversation.read',
  'conversation.send',
  'memory.use',
  'skills.read',
  'skills.write',
  'activity.read',
  'decisions.query',
  'schedules.manage',
  'subscriptions.github',
  'workspace.files',
  'process.exec',
  'ssh.manage',
  'web.browse',
  'remote.control',
  'mcp.http',
  'mcp.stdio',
  'tasks.delegate',
  'peers.call',
  'identity.manage',
  'profiles.create',
  'media.use',
  'media.image',
  'coordination.lease',
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const professionDefinitionSchema = z.strictObject({
  id: professionIdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  policyVersion: z.number().int().positive(),
  capabilities: z.array(capabilitySchema),
  defaultCapabilities: z.array(capabilitySchema),
});
export type ProfessionDefinition = z.infer<typeof professionDefinitionSchema>;

/** Catalog availability is not authorization to assign a profession or execute a tool. */
export const professionCatalogSchema = z.strictObject({
  assignable: z.boolean(),
  professions: z.array(professionDefinitionSchema),
});

/** Server-derived ceiling. Never accept this object as authority from a model or API client. */
export const professionAuthoritySchema = z.strictObject({
  professionId: professionIdSchema,
  policyVersion: z.number().int().positive(),
  capabilities: z.array(capabilitySchema),
});
export type ProfessionAuthority = z.infer<typeof professionAuthoritySchema>;

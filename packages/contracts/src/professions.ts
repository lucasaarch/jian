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

/**
 * Read-only configuration summary, NOT resource ACLs, context/inherited restrictions,
 * model/service availability or authorization to run. null lists mean unresolved legacy
 * semantics, never deny-all or all-capabilities. Assignment remains unavailable.
 */
export const effectiveProfessionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('legacy_unclassified'),
    assignable: z.literal(false),
    scope: z.literal('configuration'),
    profession: z.null(),
    ceilingCapabilities: z.null(),
    configurationEffectiveCapabilities: z.null(),
  }),
  z.strictObject({
    status: z.literal('classified'),
    assignable: z.literal(false),
    scope: z.literal('configuration'),
    profession: professionDefinitionSchema.pick({ id: true, label: true, policyVersion: true }),
    ceilingCapabilities: z.array(capabilitySchema),
    configurationEffectiveCapabilities: z.array(capabilitySchema),
  }),
]);
export type EffectiveProfession = z.infer<typeof effectiveProfessionSchema>;

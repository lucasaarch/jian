import { z } from 'zod';

/**
 * Where an imported skill came from. Provenance only: the instructions are copied at import
 * time and never refreshed on their own, so a repository that changes later cannot rewrite
 * what an agent has already been told. The owner copies them again when they choose to, which
 * moves `importedAt`.
 */
export const skillOriginSchema = z.strictObject({
  url: z.url().max(600),
  ref: z.string().max(100).optional(),
  marketplace: z.string().max(100).optional(),
  plugin: z.string().max(100).optional(),
  // As the document's frontmatter names it, when it does.
  license: z.string().max(100).optional(),
  importedAt: z.iso.datetime(),
});

export const skillImportSchema = z.strictObject({
  url: z.url().max(600),
});

export const skillNameSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/);

/**
 * Built-in skills an installation starts without: useful to some owners, noise to others, so
 * each owner decides. They still ship, and are switched on under Plugins → Skills.
 */
export const OPT_IN_SKILLS = ['discernment-nudge'] as const;

/** How many skills the library holds, the built-in ones aside. */
export const MAX_LIBRARY_SKILLS = 60;

export const skillSchema = z.strictObject({
  name: skillNameSchema,
  description: z.string().min(1).max(300),
  instructions: z.string().min(1).max(12_000),
  // Present only on a skill the owner imported.
  origin: skillOriginSchema.optional(),
  // Set on a skill an agent wrote. With neither this nor `origin`, the owner wrote it.
  writtenBy: z.literal('agent').optional(),
});

/**
 * A skill shipped with the gateway. The owner cannot edit or remove one — only switch it off
 * for the installation — so the instructions travel with it: what an agent is told has to be
 * readable.
 */
export const builtinSkillSchema = skillSchema.extend({
  enabled: z.boolean(),
});

/**
 * A skill of the installation's library, offered to every agent while `enabled`. Who wrote it
 * stays answerable: `authorProfileId` is the agent that did, the only one whose tools may change
 * or remove it. It is absent once that agent is deleted. `version` starts at 1 and counts every
 * change to what the skill says: an edit, an import over it, an update from its source.
 */
export const librarySkillSchema = skillSchema.extend({
  authorProfileId: z.uuid().optional(),
  enabled: z.boolean(),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const skillCreateSchema = skillSchema.pick({
  name: true,
  description: true,
  instructions: true,
});

export const skillPatchSchema = skillCreateSchema.omit({ name: true }).partial();

/** One switch for both kinds: a built-in skill and a library one are turned off the same way. */
export const skillEnabledSchema = z.strictObject({ enabled: z.boolean() });

/** What the switch answers: the name it was asked about, and where it now stands. */
export const skillEnabledRecordSchema = z.strictObject({
  name: skillNameSchema,
  enabled: z.boolean(),
});

/**
 * Whether an imported skill's source says something else than the library holds, as of
 * `checkedAt`. A skill edited here after its import differs from its source too.
 */
export const skillUpstreamSchema = z.strictObject({
  changed: z.boolean(),
  checkedAt: z.iso.datetime(),
});

export type SkillOrigin = z.infer<typeof skillOriginSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type BuiltinSkill = z.infer<typeof builtinSkillSchema>;
export type LibrarySkill = z.infer<typeof librarySkillSchema>;
export type SkillUpstream = z.infer<typeof skillUpstreamSchema>;

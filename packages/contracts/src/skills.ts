import { z } from 'zod';

/**
 * Where an imported skill came from. Provenance only: the instructions are copied at import
 * time and never refreshed on their own, so a repository that changes later cannot rewrite
 * what an agent has already been told.
 */
export const skillOriginSchema = z.strictObject({
  url: z.url().max(600),
  ref: z.string().max(100).optional(),
  marketplace: z.string().max(100).optional(),
  plugin: z.string().max(100).optional(),
  importedAt: z.iso.datetime(),
});

export const skillImportSchema = z.strictObject({
  url: z.url().max(600),
});

export type SkillOrigin = z.infer<typeof skillOriginSchema>;

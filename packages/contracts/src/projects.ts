import { z } from 'zod';

const repositoryUrl = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      /^https:\/\/[^\s/]+\/.+/.test(value) ||
      /^ssh:\/\/[^\s/]+\/.+/.test(value) ||
      /^[^\s/@:]+@[^\s/:]+:.+/.test(value),
    'Use an HTTPS or SSH Git repository URL',
  )
  .refine((value) => !/^https:\/\/[^/]*@/.test(value), 'Do not include credentials in the URL');

/**
 * A project is a repository an agent works on, chosen from the composer: the repository is the
 * whole input, and choosing it again opens the same project.
 */
export const projectInputSchema = z.strictObject({
  githubAccountId: z.uuid(),
  githubRepositoryId: z.number().int().positive(),
});

export const projectSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  /** The repository's `owner/repo`. Projects opened before that rule keep the name they had. */
  name: z.string().trim().min(1).max(100),
  repositoryUrl,
  githubAccountId: z.uuid().optional(),
  githubRepositoryId: z.number().int().positive().optional(),
  createdAt: z.iso.datetime(),
});

export type Project = z.infer<typeof projectSchema>;

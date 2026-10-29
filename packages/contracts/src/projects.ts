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

export const projectInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    repositoryUrl: repositoryUrl.optional(),
    githubAccountId: z.uuid().optional(),
    githubRepositoryId: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      value.repositoryUrl
        ? !value.githubAccountId && !value.githubRepositoryId
        : Boolean(value.githubAccountId && value.githubRepositoryId),
    'Choose a GitHub repository or provide a repository URL.',
  );

export const projectSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  repositoryUrl,
  githubAccountId: z.uuid().optional(),
  githubRepositoryId: z.number().int().positive().optional(),
  createdAt: z.iso.datetime(),
});

export type Project = z.infer<typeof projectSchema>;

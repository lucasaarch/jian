import { z } from 'zod';

export const teamSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300),
  profileIds: z.array(z.uuid()).max(500),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const profileIdsSchema = z
  .array(z.uuid())
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, 'Agent memberships must be unique');

export const teamInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).default(''),
  profileIds: profileIdsSchema.default([]),
});

export const teamPatchSchema = teamInputSchema;

export type Team = z.infer<typeof teamSchema>;
export type TeamInput = z.infer<typeof teamInputSchema>;

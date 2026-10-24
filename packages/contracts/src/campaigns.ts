import { z } from 'zod';

export const salesCampaignSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(12_000),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const salesCampaignInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(12_000),
});

export type SalesCampaign = z.infer<typeof salesCampaignSchema>;
export type SalesCampaignInput = z.infer<typeof salesCampaignInputSchema>;

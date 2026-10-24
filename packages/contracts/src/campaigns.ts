import { z } from 'zod';

const emptyRules = {
  productOrService: '',
  offer: '',
  price: '',
  audience: '',
  benefits: '',
  eligibility: '',
  terms: '',
  callToAction: '',
};
const emptyPlaybook = {
  opening: '',
  discoveryQuestions: [],
  qualificationCriteria: [],
  objectionHandling: '',
  closing: '',
};

export const salesCampaignRulesSchema = z.strictObject({
  productOrService: z.string().trim().max(3000).default(''),
  offer: z.string().trim().max(3000).default(''),
  price: z.string().trim().max(500).default(''),
  audience: z.string().trim().max(2000).default(''),
  benefits: z.string().trim().max(3000).default(''),
  eligibility: z.string().trim().max(3000).default(''),
  terms: z.string().trim().max(4000).default(''),
  callToAction: z.string().trim().max(1000).default(''),
});

export const salesCampaignPlaybookSchema = z.strictObject({
  opening: z.string().trim().max(1000).default(''),
  discoveryQuestions: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  qualificationCriteria: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  objectionHandling: z.string().trim().max(5000).default(''),
  closing: z.string().trim().max(1000).default(''),
});

const campaignDate = z.iso.date().nullable().default(null);

export const salesCampaignOutcomeSchema = z.enum(['qualified', 'not_qualified', 'escalated']);

const salesCampaignInputFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(12_000),
  rules: salesCampaignRulesSchema.default(emptyRules),
  playbook: salesCampaignPlaybookSchema.default(emptyPlaybook),
  active: z.boolean().default(true),
  startsOn: campaignDate,
  endsOn: campaignDate,
};

const dateWindow = <T extends { startsOn: string | null; endsOn: string | null }>(value: T) =>
  !value.startsOn || !value.endsOn || value.startsOn <= value.endsOn;

export const salesCampaignInputSchema = z
  .strictObject(salesCampaignInputFields)
  .refine(dateWindow, 'Campaign end date must be on or after its start date');

export const salesCampaignAgentUpdateSchema = z
  .strictObject({ id: z.uuid(), ...salesCampaignInputFields })
  .refine(dateWindow, 'Campaign end date must be on or after its start date');

export const salesCampaignOutcomeInputSchema = z.strictObject({
  campaignId: z.uuid().optional(),
  outcome: salesCampaignOutcomeSchema,
});

export const salesCampaignEscalationInputSchema = z.strictObject({
  campaignId: z.uuid().optional(),
  reason: z.string().trim().min(1).max(1000),
});

export const salesCampaignSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(12_000),
  rules: salesCampaignRulesSchema.default(emptyRules),
  playbook: salesCampaignPlaybookSchema.default(emptyPlaybook),
  active: z.boolean().default(true),
  startsOn: campaignDate,
  endsOn: campaignDate,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const salesCampaignReportQuerySchema = z.strictObject({
  days: z.coerce
    .number()
    .int()
    .refine((days) => [7, 30, 90].includes(days))
    .default(30),
});

export const salesCampaignReportSchema = z.strictObject({
  days: z.number().int(),
  since: z.iso.date(),
  through: z.iso.date(),
  campaigns: z.array(
    z.strictObject({
      campaignId: z.uuid().nullable(),
      campaignName: z.string(),
      lookups: z.number().int().nonnegative(),
      qualified: z.number().int().nonnegative(),
      notQualified: z.number().int().nonnegative(),
      escalated: z.number().int().nonnegative(),
    }),
  ),
});

export type SalesCampaign = z.infer<typeof salesCampaignSchema>;
export type SalesCampaignInput = z.infer<typeof salesCampaignInputSchema>;
export type SalesCampaignReport = z.infer<typeof salesCampaignReportSchema>;
export type SalesCampaignOutcome = z.infer<typeof salesCampaignOutcomeSchema>;

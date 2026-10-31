import { z } from 'zod';

/** One grapheme prevents text masquerading as a reaction; joined and skin-tone emoji stay valid. */
export const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(32)
  .refine(
    (value) =>
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(value) &&
      [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length === 1,
    'Use one emoji',
  );
export const messageReactionInputSchema = z.strictObject({ emoji: reactionEmojiSchema.nullable() });
export const messageReactionSchema = z.strictObject({
  actor: z.enum(['owner', 'agent']),
  emoji: reactionEmojiSchema,
});
export const channelMessageSchema = z.strictObject({
  id: z.string().min(1).max(200),
  participant: z.string().min(1).max(200).optional(),
});
export const reactionDeliverySchema = z.strictObject({
  messageId: z.string().min(1).max(200),
  participant: z.string().min(1).max(200).optional(),
  fromMe: z.boolean(),
  emoji: reactionEmojiSchema.nullable(),
});
export type ReactionDelivery = z.infer<typeof reactionDeliverySchema>;

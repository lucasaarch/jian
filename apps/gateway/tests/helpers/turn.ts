/**
 * The turn context of a built prompt: the message just before the request that holds what
 * changes each turn — the time, recalled memories, activities, the objective, conversations.
 */
export const turnOf = (context: {
  messages: Array<{ content: string }>;
  currentStartIndex?: number;
}) => context.messages[context.currentStartIndex ?? 0]?.content ?? '';

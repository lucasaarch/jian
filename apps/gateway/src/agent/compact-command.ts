/**
 * What the owner writes, alone, to have a conversation's context compacted now rather than when
 * it fills: the panel's Compact button sends it too.
 */
export const COMPACT_COMMAND = '/compact';

export const isCompactCommand = (input: string) => input.trim() === COMPACT_COMMAND;

/**
 * What the agent reads in place of the command, once the compaction is over: what it came to,
 * for one line to the owner. The command is not a task, so nothing else is asked of it.
 */
export function compactNote(result: { beforeTokens: number; afterTokens: number } | undefined) {
  const outcome = result
    ? `The context was compacted from about ${result.beforeTokens.toLocaleString('en')} to about ${result.afterTokens.toLocaleString('en')} tokens: older turns are now a summary.`
    : 'There was nothing old enough to compact: the context is already as short as it gets.';
  return `The owner asked to compact this conversation's context (${COMPACT_COMMAND}). ${outcome} Tell them so in one short sentence, and do nothing else.`;
}

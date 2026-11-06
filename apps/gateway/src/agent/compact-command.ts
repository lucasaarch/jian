/**
 * What the owner writes, alone, to have a conversation's context compacted now rather than when
 * it fills: the panel's Compact button sends it too. The panel keeps it out of the chat.
 */
export const COMPACT_COMMAND = '/compact';

export const isCompactCommand = (input: string) => input.trim() === COMPACT_COMMAND;

/**
 * What the agent reads in place of the command, once the compaction is over: what it came to,
 * for one line to the owner. The command is not a task, so nothing else is asked of it.
 */
export function compactNote(
  result: { beforeTokens: number; afterTokens: number } | undefined,
  failed?: string,
) {
  const outcome = failed
    ? `Compaction failed: ${failed}`
    : result && result.afterTokens < result.beforeTokens
      ? `The context was compacted from about ${result.beforeTokens.toLocaleString('en')} to about ${result.afterTokens.toLocaleString('en')} tokens: older turns are now a summary.`
      : 'There was nothing old enough to compact yet: the latest turns are always kept whole.';
  return `The owner asked to compact this conversation's context (${COMPACT_COMMAND}). ${outcome} Tell them that, naming the failure when there is one, in one or two short sentences, and do nothing else.`;
}

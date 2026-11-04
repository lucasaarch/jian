import type { Message, RunApproval, RunQuestion, Subagent } from '../../lib/api';
import type { placeSteps } from './progress';

export type DisplayMessage = {
  message: Message;
  lastMessage: Message;
  index: number;
  lastIndex: number;
};

/**
 * Channel comments arrive in pieces, but in the panel they are one Markdown answer. Keep turns,
 * tool activity, and messages with their own purpose as visible boundaries. Joining must never
 * lose anything, so what sits between two lines also divides them: an agent made there, and a
 * card that takes the place of the line it asked with and of nothing else.
 */
export function groupMessages(
  messages: Message[],
  placed: Map<string, ReturnType<typeof placeSteps>>,
  crewBefore: Map<string, Subagent[]>,
  asks: Map<string, { approval?: RunApproval; question?: RunQuestion }>,
): DisplayMessage[] {
  const groups: DisplayMessage[] = [];

  for (let index = 0; index < messages.length; ) {
    const first = messages[index];
    if (!first) {
      index += 1;
      continue;
    }

    const sources = [first];
    let previous = first;
    let lastIndex = index;

    while (lastIndex + 1 < messages.length) {
      const next = messages[lastIndex + 1];
      if (!next) break;
      const runId = previous.runId;
      const activity = runId ? placed.get(runId)?.after.get(previous.id) : undefined;

      if (
        previous.role !== 'assistant' ||
        next.role !== 'assistant' ||
        previous.call ||
        next.call ||
        previous.purpose ||
        next.purpose ||
        !runId ||
        next.runId !== runId ||
        activity?.length ||
        crewBefore.has(next.id) ||
        ((asks.get(runId)?.approval || asks.get(runId)?.question) &&
          !messages
            .slice(lastIndex + 2)
            .some((later) => later.runId === runId && later.role === 'assistant')) ||
        /\[(?:Attached media: |File not opened, it was not sent to you: [^\]]*?media ID )[0-9a-f-]{36}/.test(
          previous.content + next.content,
        )
      ) {
        break;
      }

      sources.push(next);
      previous = next;
      lastIndex += 1;
    }

    groups.push({
      message:
        sources.length === 1
          ? first
          : {
              ...first,
              content: sources.map((source) => source.content).join('\n\n'),
              ...(sources.some((source) => source.reactions?.length)
                ? { reactions: sources.flatMap((source) => source.reactions ?? []) }
                : {}),
            },
      lastMessage: previous,
      index,
      lastIndex,
    });
    index = lastIndex + 1;
  }

  return groups;
}

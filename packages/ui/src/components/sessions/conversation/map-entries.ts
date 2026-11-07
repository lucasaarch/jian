import type { Message } from '../../../lib/api';
import { plainText } from '../../ui/markdown';
import type { MapEntry } from '../conversation-map';
import type { Asks } from './store';

/** The owner's own messages, each with the first line of the answer it got, for the map. */
export function mapEntries(messages: Message[], asks: Map<string, Asks>): MapEntry[] {
  return messages
    .filter((message) => message.role === 'user' && !message.call && !message.purpose)
    .map((message) => {
      const replies = messages.filter(
        (item) => item.role === 'assistant' && item.runId && item.runId === message.runId,
      );
      const asked = message.runId ? asks.get(message.runId) : undefined;
      // A turn that only stopped to ask said nothing yet: its line is the gateway's, drawn as a
      // card, so the map says what it asked instead.
      const first =
        replies.length === 1 && asked?.approval
          ? `Asked for approval: ${asked.approval.title}`
          : replies.length === 1 && asked?.question
            ? `Asked: ${plainText(asked.question.prompt).replace(/\s+/g, ' ')}`
            : replies[0]
              ? plainText(replies[0].content)
                  .split('\n')
                  .find((line) => line.trim())
              : undefined;

      return {
        id: message.id,
        text: plainText(message.content).replace(/\s+/g, ' ').trim(),
        ...(first ? { reply: first.trim() } : {}),
      };
    })
    .filter((entry) => entry.text);
}

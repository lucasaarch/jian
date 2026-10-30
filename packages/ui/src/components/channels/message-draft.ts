import { DEFAULT_CHANNEL_MESSAGES } from '@jian/contracts';
import type { Channel } from '../../lib/api';

export type ChannelMessages = typeof DEFAULT_CHANNEL_MESSAGES;

/** The wording as it is edited: each list of replies in one line, separated by commas. */
export type MessagesDraft = {
  approval: string;
  question: string;
  approveWords: string;
  rejectWords: string;
};

const draftOf = (messages: ChannelMessages): MessagesDraft => ({
  approval: messages.approval,
  question: messages.question,
  approveWords: messages.approveWords.join(', '),
  rejectWords: messages.rejectWords.join(', '),
});

/** What a channel says now: its own wording, or the defaults until it has one. */
export const savedDraft = (channel: Channel) =>
  draftOf(channel.messages ?? DEFAULT_CHANNEL_MESSAGES);

export const defaultDraft = () => draftOf(DEFAULT_CHANNEL_MESSAGES);

const words = (text: string) =>
  text
    .split(',')
    .map((word) => word.trim())
    .filter(Boolean);

/**
 * The wording to save, or why it cannot be: a reply must be able to say yes and no, and no word
 * may mean both. The words are the people's replies, so they may be in any language.
 */
export function messagesOf(
  draft: MessagesDraft,
): { messages: ChannelMessages } | { error: string } {
  const approveWords = words(draft.approveWords);
  const rejectWords = words(draft.rejectWords);

  if (!approveWords.length || !rejectWords.length)
    return { error: 'Give at least one word for yes and one for no.' };
  if (approveWords.some((word) => rejectWords.includes(word)))
    return { error: 'A word cannot mean both yes and no.' };

  return {
    messages: {
      approval: draft.approval.trim(),
      question: draft.question.trim(),
      approveWords,
      rejectWords,
    },
  };
}

import { create } from 'zustand';

/**
 * A message the owner sent that the conversation does not hold yet: drawn at once, as a
 * messenger does, while the gateway is asked. `sent` waits for the history to bring the stored
 * message, the turn's run naming it; `failed` stays, with why, until it is sent again or let go.
 */
export type Outgoing = {
  key: string;
  sessionId: string;
  text: string;
  mediaIds: string[];
  replyTo?: { id: string; content: string };
  at: string;
  state: 'sending' | 'failed' | 'sent';
  error?: string;
  runId?: string;
};

export const useOutbox = create<{ items: Outgoing[] }>(() => ({ items: [] }));

/** Each message's way of being sent, kept out of the state: one key, every attempt. */
const senders = new Map<string, () => Promise<void>>();

const update = (key: string, change: (item: Outgoing) => Outgoing) =>
  useOutbox.setState((state) => ({
    items: state.items.map((item) => (item.key === key ? change(item) : item)),
  }));

const remove = (keys: Set<string>) => {
  for (const key of keys) senders.delete(key);
  useOutbox.setState((state) => ({ items: state.items.filter((item) => !keys.has(item.key)) }));
};

/**
 * Shows a message as sent and sends it. `deliver` posts it under `key`, which the gateway keeps
 * per message, so an attempt made again after one that did land is the same message, not a
 * second. `delivered` runs once it has, to read the conversation again.
 */
export function sendNow(message: {
  sessionId: string;
  text: string;
  mediaIds: string[];
  replyTo?: { id: string; content: string };
  deliver: (key: string) => Promise<{ id: string }>;
  delivered: () => void;
}): void {
  const key = crypto.randomUUID();
  const attempt = async () => {
    update(key, ({ error: _was, ...item }) => ({ ...item, state: 'sending' }));
    try {
      const run = await message.deliver(key);
      update(key, (item) => ({ ...item, state: 'sent', runId: run.id }));
      message.delivered();
    } catch (failure) {
      const error = failure instanceof Error ? failure.message : 'The message could not be sent.';
      update(key, (item) => ({ ...item, state: 'failed', error }));
    }
  };
  senders.set(key, attempt);
  useOutbox.setState((state) => ({
    items: [
      ...state.items,
      {
        key,
        sessionId: message.sessionId,
        text: message.text,
        mediaIds: message.mediaIds,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        at: new Date().toISOString(),
        state: 'sending',
      },
    ],
  }));
  void attempt();
}

/** Sends a failed message again, under the key it had. */
export const resend = (key: string) => void senders.get(key)?.();

/** Lets a failed message go: it never reached the conversation. */
export const discard = (key: string) => remove(new Set([key]));

/**
 * Whether the conversation now holds a sent message: the stored one carries the run it started
 * or joined, and the words, which tell apart two sent to one turn while it ran.
 */
export const landed = (
  item: Outgoing,
  messages: { role: string; runId?: string | undefined; content: string }[],
) =>
  item.state === 'sent' &&
  messages.some(
    (message) =>
      message.role === 'user' &&
      message.runId === item.runId &&
      message.content.includes(item.text),
  );

/** Forgets the sent messages the conversation has brought back, once it has. */
export const forgetLanded = (keys: string[]) => {
  if (keys.length) remove(new Set(keys));
};

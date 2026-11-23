/** The wait after a message first fails to go through, in ms; it doubles from here. */
const FIRST_WAIT_MS = 2_000;
/**
 * The longest wait while the conversation is only busy (a 409 or a 429), in ms. That clears the
 * moment a run ends, and the person is waiting for their message to be read.
 */
const LONGEST_BUSY_MS = 8_000;
/** The longest wait for anything else, in ms: it may never clear, and each try reads the row. */
const LONGEST_WAIT_MS = 5 * 60_000;
/** One line in the log per this many failures after the first, so a stuck message stays visible. */
const TOLD_EVERY = 10;

type Held = { channelId: string; chatId: string; attempts: number; retryAt: number };

/**
 * What this process knows of inbox items that could not go through yet, by id. It lives in memory
 * because the table has nowhere to keep it, and it needs nothing to survive: after a restart an
 * item is simply tried again. An item never leaves the inbox for failing, since a message may
 * not be lost; it holds back only the later messages of its own chat, whose order it protects.
 */
export class InboxRetries {
  private readonly held = new Map<string, Held>();

  constructor(private readonly clock: () => number) {}

  /** Lets go of what no longer waits: a settled item, or a channel that is gone. */
  keep(channelId: string, pending: readonly string[]) {
    const still = new Set(pending);
    for (const [id, item] of this.held) {
      if (item.channelId === channelId && !still.has(id)) this.held.delete(id);
    }
  }

  keepChannels(live: ReadonlySet<string>) {
    for (const [id, item] of this.held) {
      if (!live.has(item.channelId)) this.held.delete(id);
    }
  }

  /** The item's chat when it is known, so a row held back is not read again to learn it. */
  chatOf(id: string) {
    return this.held.get(id)?.chatId;
  }

  /** Whether the item failed and its wait is not over. */
  waiting(id: string) {
    return (this.held.get(id)?.retryAt ?? 0) > this.clock();
  }

  /** Remembers the chat of an item that waits behind an earlier one of that chat. */
  behind(id: string, channelId: string, chatId: string) {
    if (!this.held.has(id)) this.held.set(id, { channelId, chatId, attempts: 0, retryAt: 0 });
  }

  /** Records a failure; `told` says whether this one belongs in the log. */
  failed(id: string, channelId: string, chatId: string, busy: boolean) {
    const attempts = (this.held.get(id)?.attempts ?? 0) + 1;
    const longest = busy ? LONGEST_BUSY_MS : LONGEST_WAIT_MS;
    const wait = Math.min(FIRST_WAIT_MS * 2 ** Math.min(attempts - 1, 16), longest);
    this.held.set(id, { channelId, chatId, attempts, retryAt: this.clock() + wait });

    return { attempts, told: attempts === 1 || attempts % TOLD_EVERY === 0 };
  }

  passed(id: string) {
    this.held.delete(id);
  }
}

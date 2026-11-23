/**
 * How many messages with an attachment one device takes in at once. Each holds its download, up
 * to 16 MB, its base64 and the wait for the profile's lock, outside the JS heap: a reconnect that
 * replays a backlog would otherwise hold all of them together.
 */
export const ATTACHMENTS_AT_ONCE = 3;

/**
 * The order and the pace at which a device's messages are taken in. Within a chat each waits for
 * the one before, so a text sent after a photo is not stored ahead of it while the photo
 * downloads. Across chats they run side by side, and only those carrying an attachment wait for
 * one of the few places.
 */
export class DeviceIntake {
  private readonly chats = new Map<string, Promise<void>>();
  private readonly queued: Array<() => void> = [];
  private busy = 0;

  constructor(private readonly slots = ATTACHMENTS_AT_ONCE) {}

  /** Settles as `work` does; a failure stops nothing behind it in the chat. */
  take(chat: string, heavy: boolean, work: () => Promise<void>): Promise<void> {
    const before = this.chats.get(chat) ?? Promise.resolve();
    const turn = before.then(() => (heavy ? this.inSlot(work) : work()));
    const settled = turn.catch(() => {});
    this.chats.set(chat, settled);
    void settled.then(() => {
      if (this.chats.get(chat) === settled) this.chats.delete(chat);
    });

    return turn;
  }

  private async inSlot(work: () => Promise<void>) {
    if (this.busy >= this.slots) {
      // The place is handed over directly by the one leaving, so `busy` never dips between them.
      await new Promise<void>((resolve) => this.queued.push(resolve));
    } else {
      this.busy += 1;
    }

    try {
      await work();
    } finally {
      const next = this.queued.shift();
      if (next) next();
      else this.busy -= 1;
    }
  }
}

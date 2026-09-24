/**
 * Releases an answer a paragraph at a time, while it is still being written.
 *
 * A chat is a sequence of messages, not one long block: the agent is told a blank line ends a
 * message, and this is what makes that true. Holding the whole answer until the run finishes
 * and cutting it up afterwards produces the same words in the same order, but they all land at
 * once, minutes after the person asked — which is what reading a burst of notifications feels
 * like instead of a conversation.
 *
 * Only a paragraph with more text behind it is released. The last one is left to be the run's
 * answer, so a run always ends with something to show and nothing is sent twice.
 */
export class Narrator {
  private buffer = '';

  constructor(private readonly release: (text: string) => Promise<void>) {}

  async delta(text: string): Promise<void> {
    this.buffer += text;

    for (;;) {
      const split = this.buffer.indexOf('\n\n');

      if (split < 0) {
        return;
      }

      const paragraph = this.buffer.slice(0, split).trim();

      this.buffer = this.buffer.slice(split + 2);

      if (paragraph) {
        await this.release(paragraph);
      }
    }
  }

  /**
   * A step that ends on a tool call has said everything it is going to say, so the tail is
   * released too: the person hears what the agent is about to do before it does it.
   */
  async endStep(more: boolean): Promise<void> {
    if (!more) {
      // The turn ends here, so the tail is the answer and stays for the run to record.
      return;
    }

    const tail = this.buffer.trim();

    this.buffer = '';

    if (tail) {
      await this.release(tail);
    }
  }

  /** What is being written and not released yet, as it stands. */
  get draft(): string {
    return this.buffer.trimStart();
  }

  /** What has not been released: the run's answer. */
  get rest(): string {
    return this.buffer.trim();
  }
}

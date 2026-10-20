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
  /** True once any paragraph left this buffer for the channel — rest must not fall back to full text. */
  private releasedAny = false;
  private lastReleased = '';
  /**
   * Paragraphs released by a blank line in the current model step. Cleared when a tool step ends
   * so pre-tool commentary is not mistaken for a finished answer.
   */
  private releasedThisStep = false;

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
        this.releasedAny = true;
        this.releasedThisStep = true;
        this.lastReleased = paragraph;
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
    // Next step starts clean: earlier commentary is not the final answer.
    this.releasedThisStep = false;

    if (tail) {
      this.releasedAny = true;
      this.lastReleased = tail;
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

  /**
   * Whether any paragraph already went out as commentary. When true, an empty `rest` means the
   * whole answer was already said — falling back to the model's full `text` would duplicate it.
   */
  get released(): boolean {
    return this.releasedAny;
  }

  /**
   * The final step ended on a blank line that already flushed its last paragraph as commentary.
   * Distinct from pre-tool lines, which must not become the run's answer.
   */
  get finishedAsCommentary(): boolean {
    return this.releasedThisStep && !this.buffer.trim();
  }

  /** Last paragraph sent as commentary; used when a trailing blank line emptied `rest`. */
  get lastSaid(): string {
    return this.lastReleased;
  }
}

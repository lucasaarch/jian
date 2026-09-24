import type { RunProgress } from '@jian/contracts';

/**
 * Turns the model's stream into the one state a watcher wants: what the agent is doing now,
 * and the answer so far. Nothing here is history — the answer is written once, when the run
 * ends — so a report that is dropped or arrives late costs a frame, never a message.
 *
 * Tokens are coalesced, but a change of activity is not: "started a tool" is the report the
 * watcher is waiting for, and a tool that finishes inside one interval would otherwise never
 * be seen at all.
 */
/** How many changes of activity may wait at once before the oldest stops being worth showing. */
const URGENT_BACKLOG = 3;

export class ProgressReporter {
  private phase: RunProgress['phase'] = 'thinking';
  private tool: string | undefined;
  private text = '';
  private steps = 0;
  /** The newest token snapshot not yet written; a slower writer skips the ones in between. */
  private pending?: RunProgress;
  /**
   * Changes of activity waiting their turn. They queue instead of replacing each other because
   * each one is a distinct thing the watcher should see; the cap is what stops a model that
   * calls ten tools in a second from making the report lag behind the run.
   */
  private readonly urgent: RunProgress[] = [];
  private writing?: Promise<void>;
  // Negative infinity rather than zero: the first report goes out at once, whatever the clock
  // reads, so a watcher is never left with an empty bubble for a whole interval.
  private lastWrite = Number.NEGATIVE_INFINITY;

  /**
   * @param write  persists one snapshot; a failure is swallowed, since presentation must never
   *               end a run.
   * @param every  the floor between two token writes. Tokens arrive every few milliseconds and
   *               every watcher refreshes far slower than that.
   */
  constructor(
    private readonly write: (progress: RunProgress) => Promise<void>,
    private readonly every = 1000,
    private readonly clock: () => number = Date.now,
  ) {}

  thinking(): void {
    this.phase = 'thinking';
    this.tool = undefined;
    this.mark(true);
  }

  /** A tool interrupts the answer: the text written before it is not the text that will stand. */
  usingTool(name: string): void {
    this.phase = 'tool';
    this.tool = name;
    this.text = '';
    this.mark(true);
  }

  /**
   * The answer as it stands: only what has not gone out yet. A paragraph the agent already sent
   * is a message of the conversation, so keeping it here would show it twice.
   */
  draft(text: string): void {
    if (text === this.text) {
      return;
    }

    this.text = text;

    if (text) {
      this.phase = 'writing';
      this.tool = undefined;
    }

    this.mark(false);
  }

  /** A new message landed mid-run: the answer being written is not the one that will stand. */
  redirected(): void {
    this.phase = 'thinking';
    this.tool = undefined;
    this.text = '';
    this.mark(true);
  }

  stepEnded(): void {
    this.steps += 1;
    this.mark(false);
  }

  /** Writes whatever is outstanding, whatever the interval says. */
  async flush(): Promise<void> {
    if (this.pending) {
      this.urgent.push(this.pending);
      this.pending = undefined;
    }

    await this.writing;
    await this.pump();
  }

  private snapshot(): RunProgress {
    return {
      phase: this.phase,
      ...(this.tool ? { tool: this.tool } : {}),
      // The tail is what a reader is looking at; the head is already on their screen.
      text: this.text.length > 8000 ? this.text.slice(-8000) : this.text,
      steps: this.steps,
      updatedAt: new Date(this.clock()).toISOString(),
    };
  }

  private mark(force: boolean): void {
    // Taken here rather than at write time, so a state that lasted one instant still reports it.
    const snapshot = this.snapshot();

    if (force) {
      this.urgent.push(snapshot);
      this.urgent.splice(0, Math.max(0, this.urgent.length - URGENT_BACKLOG));
    } else {
      this.pending = snapshot;
    }

    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.writing) {
      // The loop below re-reads `pending` when its current write lands.
      return;
    }

    this.writing = this.drain().finally(() => {
      this.writing = undefined;
    });

    await this.writing;
  }

  private async drain(): Promise<void> {
    while (true) {
      const next =
        this.urgent.shift() ??
        (this.clock() - this.lastWrite >= this.every ? this.pending : undefined);

      if (!next) {
        return;
      }

      if (next === this.pending) {
        this.pending = undefined;
      }

      this.lastWrite = this.clock();

      await this.write(next).catch(() => undefined);
    }
  }
}

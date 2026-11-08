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
  private mcp: RunProgress['mcp'];
  private text = '';
  private steps = 0;
  private waiting: RunProgress['reconnecting'];
  /** The newest token snapshot not yet written; a slower writer skips the ones in between. */
  private pending?: RunProgress;
  /**
   * Changes of activity waiting their turn. They queue instead of replacing each other because
   * each one is a distinct thing the watcher should see; the cap is what stops a model that
   * calls ten tools in a second from making the report lag behind the run.
   */
  private readonly urgent: RunProgress[] = [];
  private writing?: Promise<void>;
  /**
   * True from the moment the loop starts until the moment it decides to stop, flipped in the same
   * tick as that decision. The promise above settles a microtask later, so a mark made in between
   * would trust a loop that has already left and wait for the held timer.
   */
  private draining = false;
  /** The last `updatedAt` handed out, in epoch milliseconds. */
  private stamped = Number.NEGATIVE_INFINITY;
  /**
   * Writes the held token snapshot once the interval has passed. Without it a snapshot held
   * back waits for the next change, and the model may change nothing the watcher sees for a long
   * while: writing a tool's input marks nothing, so the screen would keep a paragraph long gone.
   */
  private held?: ReturnType<typeof setTimeout>;
  // Negative infinity rather than zero: the first report goes out at once, whatever the clock
  // reads, so a watcher is never left with an empty bubble for a whole interval.
  private lastWrite = Number.NEGATIVE_INFINITY;

  /**
   * @param write  persists one snapshot; a failure is swallowed, since presentation must never
   *               end a run.
   * @param every  the floor between two token writes. Tokens arrive every few milliseconds and
   *               a screen shows far fewer frames than that; 250 ms reads as typing, not steps.
   */
  constructor(
    private readonly write: (progress: RunProgress) => Promise<void>,
    private readonly every = 250,
    private readonly clock: () => number = Date.now,
  ) {}

  thinking(): void {
    this.phase = 'thinking';
    this.tool = undefined;
    this.mark(true);
  }

  /** A tool interrupts the answer: the text written before it is not the text that will stand. */
  usingTool(name: string, mcp?: RunProgress['mcp']): void {
    this.phase = 'tool';
    this.tool = name;
    this.mcp = mcp;
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

    // A paragraph just went out as a message: the watcher must stop showing it now, not at the
    // next token, which may be a whole tool's input away.
    const released = Boolean(this.text) && !text;
    this.text = text;

    if (text) {
      this.phase = 'writing';
      this.tool = undefined;
    }

    this.mark(released);
  }

  /** A new message landed mid-run: the answer being written is not the one that will stand. */
  redirected(): void {
    this.phase = 'thinking';
    this.tool = undefined;
    this.text = '';
    this.mark(true);
  }

  /** A model call failed and is tried again at `nextAt`: the watcher sees why nothing moves. */
  reconnecting(state: { attempts: number; nextAt: Date; reason: string }): void {
    this.waiting = {
      attempts: state.attempts,
      nextAt: state.nextAt.toISOString(),
      reason: state.reason.slice(0, 200),
    };
    this.mark(true);
  }

  /** A call got through: whatever the run does next is what the watcher should see. */
  reconnected(): void {
    if (!this.waiting) return;
    this.waiting = undefined;
    this.mark(true);
  }

  stepEnded(): void {
    this.steps += 1;
    this.mark(false);
  }

  /** Writes whatever is outstanding, whatever the interval says. */
  async flush(): Promise<void> {
    clearTimeout(this.held);
    this.held = undefined;

    if (this.pending) {
      this.urgent.push(this.pending);
      this.pending = undefined;
    }

    await this.writing;
    await this.pump();
  }

  private snapshot(): RunProgress {
    // Strictly increasing per run: the stream tells a frame once per `updatedAt`, and the panel
    // takes only a strictly newer one, so two marks in one millisecond would hide the second.
    this.stamped = Math.max(this.clock(), this.stamped + 1);

    return {
      phase: this.phase,
      ...(this.tool ? { tool: this.tool, ...(this.mcp ? { mcp: this.mcp } : {}) } : {}),
      // The tail is what a reader is looking at; the head is already on their screen.
      text: this.text.length > 8000 ? this.text.slice(-8000) : this.text,
      steps: this.steps,
      ...(this.waiting ? { reconnecting: this.waiting } : {}),
      updatedAt: new Date(this.stamped).toISOString(),
    };
  }

  private mark(force: boolean): void {
    // Taken here rather than at write time, so a state that lasted one instant still reports it.
    const snapshot = this.snapshot();

    if (force) {
      // The urgent snapshot is newer than any held one: writing the held one after it would put
      // the screen back to a state the run has left.
      this.pending = undefined;
      clearTimeout(this.held);
      this.held = undefined;
      this.urgent.push(snapshot);
      this.urgent.splice(0, Math.max(0, this.urgent.length - URGENT_BACKLOG));
    } else {
      this.pending = snapshot;
    }

    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.draining) {
      // The loop below re-reads the queue and `pending` when its current write lands.
      return;
    }

    this.draining = true;
    this.writing = this.drain();
    await this.writing;
  }

  private async drain(): Promise<void> {
    while (true) {
      const next =
        this.urgent.shift() ??
        (this.clock() - this.lastWrite >= this.every ? this.pending : undefined);

      if (!next) {
        // In the same tick as the decision, so the next mark starts a loop of its own.
        this.draining = false;
        this.hold();
        return;
      }

      if (next === this.pending) {
        this.pending = undefined;
      }

      this.lastWrite = this.clock();

      await this.write(next).catch(() => undefined);
    }
  }

  /**
   * Waits out the rest of the interval for a token snapshot the loop skipped. One timer at a
   * time; it does not keep the process alive, and a write after the run ended changes nothing,
   * since only a run still at work takes progress.
   */
  private hold(): void {
    if (!this.pending || this.held) {
      return;
    }

    const wait = Math.max(0, this.every - (this.clock() - this.lastWrite));
    this.held = setTimeout(() => {
      this.held = undefined;
      void this.pump();
    }, wait);
    this.held.unref?.();
  }
}

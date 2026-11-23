/** How long a process that ended waits before it is started again, growing, in ms. */
const RETRY_MS = [1_000, 5_000, 15_000, 60_000];
/**
 * How long a process has to stay up for its next failure to count as a new one, in ms. Having
 * started says nothing: one that crashes right after would be restarted every second forever.
 */
const STABLE_MS = 60_000;

/** When to start again a process that keeps ending. */
export class RestartBackoff {
  private failures = 0;
  private startedAt: number | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  started(): void {
    this.startedAt = this.now();
  }

  /** It ended: how long to wait before the next start, in ms. */
  next(): number {
    if (this.startedAt !== undefined && this.now() - this.startedAt >= STABLE_MS) this.failures = 0;
    this.startedAt = undefined;
    const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)] ?? 60_000;
    this.failures += 1;
    return wait;
  }
}

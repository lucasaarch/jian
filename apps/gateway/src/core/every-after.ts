/**
 * Runs `work` every `ms` milliseconds counted from when its last run ended, one run at a time.
 * A fixed interval starts another run over one still going, so a slow database or GitHub stacks
 * runs and connection waiters exactly when they can least afford it.
 *
 * A failure goes to `failed` and the next run still comes. The timers never hold the process
 * open, and `stop` does not wait for a run under way.
 */
export function everyAfter(
  work: () => Promise<unknown>,
  ms: number,
  failed: (error: unknown) => void,
): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void Promise.resolve().then(work).catch(failed).finally(arm);
    }, ms);
    timer.unref();
  };

  arm();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

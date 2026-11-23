/**
 * The work's own outcome, or a failure the moment the deadline passes. The work is not stopped by
 * this: it is for what cannot be cancelled, like a load that may never finish.
 */
export function withinDeadline<T>(work: T | PromiseLike<T>, deadline: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const expired = () => reject(new Error('The browser action was cancelled or timed out'));
    // Always listened to: a late failure of work given up on must not go unhandled.
    void Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => deadline.removeEventListener('abort', expired));
    if (deadline.aborted) expired();
    else deadline.addEventListener('abort', expired, { once: true });
  });
}

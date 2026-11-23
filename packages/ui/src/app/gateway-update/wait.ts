import type { UpdateAttempt } from '@jian/contracts';

/** How long a redeploy may take, pulls included, before the panel calls it failed. */
export const UPDATE_PATIENCE_MS = 10 * 60_000;
const EVERY_MS = 5_000;

/**
 * Asks `read` until it answers on `version`, or until `patience` ms have passed. A read that
 * fails is a gateway or web still restarting, so it only means try again.
 */
export async function waitForVersion(
  read: () => Promise<{ version?: string | undefined }>,
  version: string,
  {
    patience = UPDATE_PATIENCE_MS,
    every = EVERY_MS,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: {
    patience?: number;
    every?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const until = now() + patience;
  while (now() < until) {
    const answer = await read().catch(() => undefined);
    if (answer?.version === version) return true;
    await sleep(every);
  }
  return false;
}

/** What went wrong in an attempt, naming each part that failed. */
export function failures(attempt: UpdateAttempt): string[] {
  return attempt.results
    .filter((result) => !result.ok)
    .map(
      (result) => `${result.component === 'web' ? 'Web' : 'Gateway'}: ${result.error ?? 'failed'}`,
    );
}

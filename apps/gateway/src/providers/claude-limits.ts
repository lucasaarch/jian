import type { SubscriptionUsage } from '@jian/contracts';

type Window = NonNullable<SubscriptionUsage['fiveHour']>;

/** What the last Claude subscription response said of its windows, and when it said it. */
type Seen = { fiveHour: Window | null; weekly: Window | null; at: number };

/**
 * Every answer Anthropic gives a subscription carries how much of its windows is used, in the
 * `anthropic-ratelimit-unified-*` headers that Claude Code itself reads for its limits. The
 * usage endpoint that would say so directly refuses a `claude setup-token` credential (429), so
 * this is how a gateway on such a token knows: from the last run that went through it. Kept in
 * memory, per provider; after a restart they come back with the next run.
 */
const seen = new Map<string, Seen>();

/** The key a provider's limits are kept under; one configured from the environment has none. */
export const limitsKey = (providerId: string | undefined) => providerId ?? 'environment';

/** Utilization comes as a share (0.42); a percent above one is taken as already one. */
function percent(value: string | null): number | null {
  if (value === null) return null;
  const share = Number(value);
  if (!Number.isFinite(share) || share < 0) return null;
  return share <= 1 ? share * 100 : share;
}

/** Resets come as Unix seconds; anything else leaves the reset unknown. */
function reset(value: string | null): string | null {
  const seconds = value === null ? Number.NaN : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function windowFrom(headers: Headers, name: '5h' | '7d'): Window | null {
  const usedPercent = percent(headers.get(`anthropic-ratelimit-unified-${name}-utilization`));
  if (usedPercent === null) return null;
  return {
    usedPercent,
    resetsAt: reset(headers.get(`anthropic-ratelimit-unified-${name}-reset`)),
  };
}

/** Keeps what a response says of the provider's windows; a response that says nothing is ignored. */
export function recordClaudeLimits(key: string, headers: Headers, now = Date.now()): void {
  const fiveHour = windowFrom(headers, '5h');
  const weekly = windowFrom(headers, '7d');
  if (!fiveHour && !weekly) return;
  const before = seen.get(key);
  // A response that names one window keeps what the other said last.
  seen.set(key, {
    fiveHour: fiveHour ?? before?.fiveHour ?? null,
    weekly: weekly ?? before?.weekly ?? null,
    at: now,
  });
}

/**
 * The provider's windows as last seen, once their resets have not passed: a window that reset
 * since starts over, so its old share is no longer true and is left out.
 */
export function claudeLimits(key: string, now = Date.now()): Omit<Seen, 'at'> | undefined {
  const last = seen.get(key);
  if (!last) return undefined;
  const current = (window: Window | null) =>
    window && (!window.resetsAt || Date.parse(window.resetsAt) > now) ? window : null;
  const fiveHour = current(last.fiveHour);
  const weekly = current(last.weekly);
  return fiveHour || weekly ? { fiveHour, weekly } : undefined;
}

/** For tests: forget everything seen. */
export function forgetClaudeLimits(): void {
  seen.clear();
}

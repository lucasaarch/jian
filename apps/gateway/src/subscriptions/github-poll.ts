import {
  SUBSCRIPTION_DEFAULT_POLL_SECONDS,
  type Subscription,
  type SubscriptionObservation,
} from '@jian/contracts';

export type GithubTokenSource = {
  tokenFor(profileId: string): Promise<string | undefined>;
};

type GithubEvent = Subscription['filter']['events'][number];

type CheckRun = {
  name?: string;
  status?: string;
  conclusion?: string | null;
};

type PullPayload = {
  state?: string;
  merged?: boolean;
  head?: { sha?: string };
};

type CheckRunsPayload = {
  check_runs?: CheckRun[];
};

export type PollWake = {
  event: GithubEvent;
  deliveryKey: string;
  summary: string[];
  observation: SubscriptionObservation;
};

/** Seconds until the next poll for this subscription. */
export function pollIntervalMs(filter: Subscription['filter']): number {
  const seconds = filter.pollIntervalSeconds ?? SUBSCRIPTION_DEFAULT_POLL_SECONDS;
  return seconds * 1_000;
}

function apiHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'jian-gateway',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function readJson<T>(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: T | undefined; error?: string }> {
  try {
    const response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        status: response.status,
        body: undefined,
        error: text.slice(0, 200) || `GitHub responded ${response.status}`,
      };
    }
    return { ok: true, status: response.status, body: (await response.json()) as T };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: undefined,
      error: error instanceof Error ? error.message : 'GitHub request failed',
    };
  }
}

function matchingChecks(runs: CheckRun[], checkName: string | undefined): CheckRun[] {
  if (!checkName) return runs;
  const needle = checkName.toLowerCase();
  return runs.filter((run) => (run.name ?? '').toLowerCase().includes(needle));
}

function observeChecks(
  runs: CheckRun[],
  checkName: string | undefined,
): Pick<SubscriptionObservation, 'checksCompleted' | 'checkConclusion'> {
  const relevant = matchingChecks(runs, checkName);
  if (relevant.length === 0) {
    return { checksCompleted: false };
  }
  const completed = relevant.every((run) => run.status === 'completed');
  if (!completed) return { checksCompleted: false };
  const conclusions = relevant.map((run) => run.conclusion ?? 'neutral');
  const checkConclusion = conclusions.every((value) => value === conclusions[0])
    ? (conclusions[0] ?? 'neutral')
    : conclusions.includes('failure') || conclusions.includes('timed_out')
      ? 'failure'
      : conclusions.includes('cancelled')
        ? 'cancelled'
        : 'success';
  return { checksCompleted: true, checkConclusion };
}

/**
 * Reads the current GitHub PR / check state for a subscription filter.
 * Needs `pullNumber` to observe anything useful for this MVP.
 */
export async function observeGithub(
  filter: Subscription['filter'],
  fetcher: typeof fetch,
  token: string | undefined,
): Promise<{ observation: SubscriptionObservation; error?: string }> {
  if (!filter.pullNumber) {
    return {
      observation: {},
      error: 'Set pullNumber on the subscription to poll GitHub; webhook remains optional.',
    };
  }

  const headers = apiHeaders(token);
  const base = `https://api.github.com/repos/${filter.owner}/${filter.repo}`;
  const pull = await readJson<PullPayload>(fetcher, `${base}/pulls/${filter.pullNumber}`, headers);
  if (!pull.ok || !pull.body) {
    return {
      observation: {},
      error:
        pull.status === 401 || pull.status === 403
          ? 'GitHub refused the poll (sign in with gh in this profile’s workspace, or use a public repo).'
          : (pull.error ?? 'Could not read the pull request'),
    };
  }

  const pullState = pull.body.state === 'closed' ? 'closed' : 'open';
  const merged = Boolean(pull.body.merged);
  const headSha = pull.body.head?.sha;
  const observation: SubscriptionObservation = {
    pullState,
    merged,
    ...(headSha ? { headSha } : {}),
  };

  if (!filter.events.includes('check_suite.completed') || !headSha) {
    return { observation };
  }

  const checks = await readJson<CheckRunsPayload>(
    fetcher,
    `${base}/commits/${headSha}/check-runs?per_page=100`,
    headers,
  );
  if (!checks.ok || !checks.body) {
    return {
      observation,
      error: checks.error ?? 'Could not read check runs',
    };
  }

  return {
    observation: {
      ...observation,
      ...observeChecks(checks.body.check_runs ?? [], filter.checkName),
    },
  };
}

/** Canonical form so optional fields and `false` vs omitted compare equal. */
export function canonicalizeObservation(
  observation: SubscriptionObservation | undefined,
): SubscriptionObservation {
  if (!observation) return {};
  return {
    ...(observation.pullState ? { pullState: observation.pullState } : {}),
    ...(observation.merged !== undefined ? { merged: observation.merged } : {}),
    ...(observation.headSha ? { headSha: observation.headSha } : {}),
    ...(observation.checksCompleted !== undefined
      ? { checksCompleted: observation.checksCompleted }
      : {}),
    ...(observation.checkConclusion ? { checkConclusion: observation.checkConclusion } : {}),
  };
}

export function observationsEqual(
  left: SubscriptionObservation | undefined,
  right: SubscriptionObservation | undefined,
): boolean {
  const a = canonicalizeObservation(left);
  const b = canonicalizeObservation(right);
  return (
    a.pullState === b.pullState &&
    a.merged === b.merged &&
    a.headSha === b.headSha &&
    Boolean(a.checksCompleted) === Boolean(b.checksCompleted) &&
    (a.checkConclusion ?? undefined) === (b.checkConclusion ?? undefined)
  );
}

/**
 * Keeps a completed check snapshot for the same head when GitHub briefly returns empty or
 * in-progress runs. Also refuses to replace a known PR snapshot with an empty/error poll —
 * wiping that memory made the next good poll look like a fresh transition and re-woke the
 * agent every interval.
 */
export function stabilizeObservation(
  previous: SubscriptionObservation | undefined,
  next: SubscriptionObservation,
): SubscriptionObservation {
  const raw = canonicalizeObservation(next);
  const prior = canonicalizeObservation(previous);

  // Failed or empty fetch: keep what we already know rather than erasing the latch.
  if (!raw.pullState && !raw.headSha && (prior.pullState || prior.headSha)) {
    return prior;
  }

  if (
    prior.checksCompleted &&
    prior.headSha &&
    prior.headSha === raw.headSha &&
    !raw.checksCompleted
  ) {
    return canonicalizeObservation({
      ...raw,
      checksCompleted: true,
      ...(prior.checkConclusion ? { checkConclusion: prior.checkConclusion } : {}),
    });
  }
  return raw;
}

function checkLabel(observation: SubscriptionObservation | undefined): string {
  if (!observation?.checksCompleted) return 'pending';
  return observation.checkConclusion ?? 'completed';
}

function pullLabel(observation: SubscriptionObservation | undefined): string {
  if (observation?.pullState === 'closed') {
    return observation.merged ? 'merged' : 'closed';
  }
  if (observation?.pullState === 'open') return 'open';
  return 'unknown';
}

function deltaLines(
  previous: SubscriptionObservation | undefined,
  next: SubscriptionObservation,
): string[] {
  const lines: string[] = [];
  const prevPull = pullLabel(previous);
  const nextPull = pullLabel(next);
  if (prevPull !== nextPull) {
    lines.push(`Changed: pull ${prevPull} → ${nextPull}`);
  }
  const prevCheck = checkLabel(previous);
  const nextCheck = checkLabel(next);
  if (prevCheck !== nextCheck) {
    lines.push(`Changed: checks ${prevCheck} → ${nextCheck}`);
  }
  if (previous?.headSha && next.headSha && previous.headSha !== next.headSha) {
    lines.push(`Changed: head ${previous.headSha.slice(0, 7)} → ${next.headSha.slice(0, 7)}`);
  }
  return lines;
}

/**
 * Compares the last stored snapshot to the latest poll. Returns a wake only for meaningful
 * transitions (CI pending→terminal, conclusion change, open→merged/closed). Unchanged
 * snapshots — including steady open + green while waiting for merge — stay silent.
 */
export function detectPollWake(
  subscription: Pick<Subscription, 'filter' | 'lastObservation'>,
  nextRaw: SubscriptionObservation,
): PollWake | undefined {
  const { filter, lastObservation: previous } = subscription;
  const next = stabilizeObservation(previous, nextRaw);
  const pull = filter.pullNumber ?? 0;

  if (observationsEqual(previous, next)) {
    return undefined;
  }

  if (
    filter.events.includes('pull_request.closed') &&
    next.pullState === 'closed' &&
    previous?.pullState !== 'closed'
  ) {
    return {
      event: 'pull_request.closed',
      deliveryKey: `poll:pull_request.closed:${pull}:${next.merged ? 'merged' : 'closed'}`,
      summary: [
        `Pull request: #${pull}`,
        `State: closed${next.merged ? ' (merged)' : ''}`,
        ...deltaLines(previous, next),
      ],
      observation: next,
    };
  }

  if (
    filter.events.includes('check_suite.completed') &&
    next.checksCompleted &&
    next.headSha &&
    !(
      previous?.checksCompleted &&
      previous.headSha === next.headSha &&
      previous.checkConclusion === next.checkConclusion
    )
  ) {
    const conclusion = next.checkConclusion ?? 'unknown';
    return {
      event: 'check_suite.completed',
      deliveryKey: `poll:check_suite.completed:${next.headSha}:${conclusion}:${filter.checkName ?? '*'}`,
      summary: [
        `Pull request: #${pull}`,
        `Head: ${next.headSha}`,
        `Check conclusion: ${conclusion}`,
        ...(filter.checkName ? [`Check name filter: ${filter.checkName}`] : []),
        ...deltaLines(previous, next),
      ],
      observation: next,
    };
  }

  // Non-wake changes (e.g. still pending, or open+green already recorded) still update storage
  // via observation on the returned undefined path — callers should persist `next` themselves.
  return undefined;
}

/** Snapshot to store after a poll: stabilized so incomplete flicker cannot erase a completion. */
export function observationToStore(
  previous: SubscriptionObservation | undefined,
  nextRaw: SubscriptionObservation,
): SubscriptionObservation {
  return stabilizeObservation(previous, nextRaw);
}

/**
 * True while an enabled listener still expects a future GitHub transition (CI finish and/or
 * PR close). Used to keep objective auto-continue quiet — the next turn comes from a wake.
 */
export function listenerIsWaiting(
  subscription: Pick<Subscription, 'enabled' | 'expiresAt' | 'filter' | 'lastObservation'>,
  now: Date = new Date(),
): boolean {
  if (!subscription.enabled) return false;
  if (Date.parse(subscription.expiresAt) <= now.getTime()) return false;

  const { filter, lastObservation: observation } = subscription;
  const watchChecks = filter.events.includes('check_suite.completed');
  const watchPull = filter.events.includes('pull_request.closed');

  // No snapshot yet: the first real observation (or wake) has not settled.
  if (!observation?.pullState && observation?.checksCompleted === undefined) {
    return true;
  }

  const waitingChecks = watchChecks && !observation?.checksCompleted;
  const waitingPull = watchPull && observation?.pullState !== 'closed';
  return waitingChecks || waitingPull;
}

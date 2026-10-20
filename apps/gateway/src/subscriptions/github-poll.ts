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

/** True when the previous observation already counted checks as finished for this head. */
function checksAlreadyDone(
  previous: SubscriptionObservation | undefined,
  next: SubscriptionObservation,
): boolean {
  return Boolean(
    previous?.checksCompleted &&
      previous.headSha === next.headSha &&
      previous.checkConclusion === next.checkConclusion,
  );
}

/**
 * Compares the last observation to the latest poll and returns a wake when an enabled event
 * has just become true (CI finished, or the pull request closed).
 */
export function detectPollWake(
  subscription: Pick<Subscription, 'filter' | 'lastObservation'>,
  next: SubscriptionObservation,
): PollWake | undefined {
  const { filter, lastObservation: previous } = subscription;
  const pull = filter.pullNumber ?? 0;

  if (
    filter.events.includes('pull_request.closed') &&
    next.pullState === 'closed' &&
    previous?.pullState !== 'closed'
  ) {
    return {
      event: 'pull_request.closed',
      deliveryKey: `poll:pull_request.closed:${pull}:${next.merged ? 'merged' : 'closed'}`,
      summary: [`Pull request: #${pull}`, `State: closed${next.merged ? ' (merged)' : ''}`],
      observation: next,
    };
  }

  if (
    filter.events.includes('check_suite.completed') &&
    next.checksCompleted &&
    next.headSha &&
    !checksAlreadyDone(previous, next)
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
      ],
      observation: next,
    };
  }

  return undefined;
}

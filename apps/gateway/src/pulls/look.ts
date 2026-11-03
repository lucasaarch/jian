import type {
  CheckPayload,
  CommentPayload,
  CommitPayload,
  Look,
  PullPayload,
  ReviewPayload,
  WatchState,
} from './changes.js';

/**
 * A request to the API of a repository `owner` holds, as the App's installation on that account;
 * undefined when the App is not installed there (`GitHubIntegrations.repoRequest`).
 */
export type RepoRequest = (
  owner: string,
  path: string,
  init?: RequestInit,
) => Promise<Response | undefined>;

export type PullRef = { owner: string; repo: string; number: number };

/** Why a look found nothing to compare. */
export type LookFailure =
  | { kind: 'unreachable'; reason: string }
  | { kind: 'limited'; retryAfterMs: number }
  | { kind: 'failed'; reason: string };

/** A list's page size: GitHub's largest. */
const PAGE = 100;
/** Pages read of one list at most: past this a pull request is a discussion, not a review. */
const PAGES = 10;
/** How long to wait when GitHub limits the App but does not say for how long, in ms. */
const LIMITED_MS = 5 * 60_000;

class Stop extends Error {
  constructor(readonly failure: LookFailure) {
    super(failure.kind);
  }
}

/**
 * Reads what changed of a pull request since `state` was recorded. Every address goes with the
 * ETag it last answered with: an unchanged one answers 304, which GitHub does not count against
 * the App's limit, and is left undefined in the look. The new ETags come back in `etags`.
 */
export async function lookAt(
  request: RepoRequest,
  pull: PullRef,
  state: WatchState,
): Promise<{ look: Look; etags: Record<string, string> } | LookFailure> {
  const etags = { ...(state.etags ?? {}) };
  const base = `/repos/${pull.owner}/${pull.repo}`;

  const read = async <T>(path: string): Promise<T | undefined> => {
    const response = await request(pull.owner, path, {
      headers: etags[path] ? { 'if-none-match': etags[path] } : {},
    });
    if (!response) {
      throw new Stop({
        kind: 'unreachable',
        reason: `The Jian GitHub App is not installed on ${pull.owner}.`,
      });
    }
    if (response.status === 304) return undefined;
    if (response.status === 429 || (response.status === 403 && limited(response))) {
      throw new Stop({ kind: 'limited', retryAfterMs: waitOf(response) });
    }
    if (response.status === 404) {
      throw new Stop({
        kind: 'unreachable',
        reason: `The Jian GitHub App cannot reach ${pull.owner}/${pull.repo}.`,
      });
    }
    if (!response.ok) {
      throw new Stop({ kind: 'failed', reason: `GitHub answered ${response.status} to ${path}.` });
    }
    const etag = response.headers.get('etag');
    if (etag) etags[path] = etag;
    return (await response.json()) as T;
  };

  /**
   * The pages of a list that changed, or undefined when none did. An unchanged page leaves its
   * items out, which costs nothing: what was seen before stays seen. The page after it is read
   * only if it was read before, which a page short of full never leads to.
   */
  const list = async <T>(path: string, pick: (body: unknown) => T[] = (body) => body as T[]) => {
    const page = (number: number) => `${path}?per_page=${PAGE}&page=${number}`;
    let items: T[] | undefined;
    for (let number = 1; number <= PAGES; number++) {
      const body = await read<unknown>(page(number));
      if (body === undefined) {
        if (!etags[page(number + 1)]) break;
        continue;
      }
      const found = pick(body);
      items = [...(items ?? []), ...found];
      if (found.length < PAGE) break;
    }
    return items;
  };

  try {
    const pullRead = await read<PullPayload>(`${base}/pulls/${pull.number}`);
    const head = pullRead?.head?.sha ?? state.headSha;
    const moved = Boolean(
      pullRead?.head?.sha && state.headSha && pullRead.head.sha !== state.headSha,
    );
    const look: Look = {
      // Unchanged since the last look: what is compared is what was recorded.
      pull: pullRead ?? {
        state: 'open',
        mergeable: state.mergeable ?? null,
        head: {
          ...(state.headSha ? { sha: state.headSha } : {}),
          ...(state.headRef ? { ref: state.headRef } : {}),
        },
      },
    };
    // Merged or closed: nothing after it is told, and nothing more is read.
    if (look.pull.state === 'closed') return { look, etags };

    const reviews = await list<ReviewPayload>(`${base}/pulls/${pull.number}/reviews`);
    const lineComments = await list<CommentPayload>(`${base}/pulls/${pull.number}/comments`);
    const comments = await list<CommentPayload>(`${base}/issues/${pull.number}/comments`);
    const checks = head
      ? await list<CheckPayload>(
          `${base}/commits/${head}/check-runs`,
          (body) => (body as { check_runs?: CheckPayload[] }).check_runs ?? [],
        )
      : undefined;
    const commits = moved
      ? await list<CommitPayload>(`${base}/pulls/${pull.number}/commits`)
      : undefined;

    if (reviews) look.reviews = reviews;
    if (lineComments) look.lineComments = lineComments;
    if (comments) look.comments = comments;
    if (checks) look.checks = checks;
    if (commits) look.commits = commits;
    return { look, etags };
  } catch (error) {
    if (error instanceof Stop) return error.failure;
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : 'GitHub did not answer.',
    };
  }
}

/** A 403 that is GitHub's limit rather than a refusal: none of the App's requests left. */
const limited = (response: Response) =>
  response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after');

/** How long GitHub asks to wait, in ms: `retry-after` in seconds, or the reset as epoch seconds. */
function waitOf(response: Response): number {
  const after = Number(response.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return after * 1_000;
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(reset * 1_000 - Date.now(), 1_000);
  return LIMITED_MS;
}

'use client';

import { Popover } from '@base-ui/react/popover';
import { Tabs } from '@base-ui/react/tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleDot,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
  RefreshCw,
  Wrench,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import { Button, buttonClass, GitHubLogo, Modal } from '@/components/ui';
import { Markdown, MarkdownLinks } from '@/components/ui/markdown';
import type {
  GatewayApi,
  GitHubIssue,
  GitHubLinkSummary,
  GitHubMergeMethod,
  GitHubPull,
} from '@/lib/api';
import { date } from '@/lib/format';
import { githubItemOf, linkBatcher } from '@/lib/github-links';
import { keys } from '@/lib/query/keys';
import { type GitHubItem, itemKey, useCrew } from '@/lib/stores/crew';
import { FileDiff } from './code-change';
import { useDrawerFocus } from './crew';

type LinksApi = Pick<GatewayApi, 'resolveGithubLinks'>;
type DrawerApi = Pick<GatewayApi, 'githubPull' | 'githubIssue' | 'mergeGithubPull'>;
type Reachable = Extract<GitHubLinkSummary, { reachable: true }>;
type State = Reachable['state'];

/**
 * How long a card's summary is trusted, and how often an open one asks again: a pull request
 * merged or closed elsewhere shows as such within about this long. The gateway keeps a summary
 * as long, so asking sooner would only read its copy.
 */
const CARD_STALE_MS = 30_000;
/** How often an open pull request in the drawer is read again, for its checks and its state. */
const OPEN_PULL_MS = 15_000;
/** While GitHub works out whether a pull request merges, ask again this often. */
const MERGEABLE_RETRY_MS = 3_000;
/** More files than this and each one starts closed: the list is read before the code. */
const OPEN_FILES = 3;

const stateNames = { open: 'Open', closed: 'Closed', merged: 'Merged' } as const;

function StateChip({ state, draft }: { state: State; draft?: boolean }) {
  const shown = draft && state === 'open' ? 'draft' : state;

  return (
    <span className="github-state" data-state={shown}>
      {shown === 'draft' ? 'Draft' : stateNames[state]}
    </span>
  );
}

type Shown = State | 'draft';

/** GitHub's own marks for where an item stands, so a reference reads at a glance. */
const pullMarks: Record<Shown, LucideIcon> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};
const issueMarks: Record<Shown, LucideIcon> = {
  open: CircleDot,
  draft: CircleDot,
  merged: CircleCheck,
  closed: CircleCheck,
};

/**
 * A link to a pull request or an issue, as a reference: its mark, coloured by where it stands,
 * and its number. The rest is a hover away; clicking follows it in the drawer.
 */
function GitHubCard({ summary, href }: { summary: Reachable; href: string }) {
  const open = useCrew((state) => state.open);
  const close = useCrew((state) => state.close);
  const following = useCrew((state) => state.following);
  const item: GitHubItem = { ...summary, url: href };
  const followed = following === itemKey(item);
  const shown: Shown = summary.draft && summary.state === 'open' ? 'draft' : summary.state;
  const Mark = (summary.kind === 'pull' ? pullMarks : issueMarks)[shown];
  const standing = shown === 'draft' ? 'Draft' : stateNames[summary.state];
  const where = `${summary.owner}/${summary.repo} #${summary.number}`;

  return (
    <button
      type="button"
      className="github-ref"
      data-kind={summary.kind}
      data-state={shown}
      aria-pressed={followed}
      aria-label={`${summary.kind === 'pull' ? 'Pull request' : 'Issue'} ${where}: ${summary.title}, ${standing}`}
      title={`${where} · ${summary.title} · ${standing}`}
      onClick={(event) => (followed ? close() : open(item, event.currentTarget))}
    >
      <Mark size={14} aria-hidden="true" />#{summary.number}
    </button>
  );
}

function GitHubLink({
  href,
  label,
  load,
}: {
  href: string;
  label: string;
  load: (url: string) => Promise<GitHubLinkSummary>;
}) {
  const { data } = useQuery({
    queryKey: keys.githubLink(href),
    queryFn: () => load(href),
    staleTime: CARD_STALE_MS,
    // Only what can still change is asked again: a merged or closed one stays as it is.
    refetchInterval: (query) => {
      const summary = query.state.data;
      return summary?.reachable && summary.state === 'open' ? CARD_STALE_MS : false;
    },
  });

  if (data?.reachable) return <GitHubCard summary={data} href={href} />;
  // Until it is known, and for good when the App cannot see it, the link stays a link.
  return (
    <a className="text-link" href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

/**
 * Links to pull requests and issues inside `children` become cards. Every card on screen is
 * looked up in one request; one the App cannot see stays the plain link it was.
 */
export function GitHubLinks({ api, children }: { api: LinksApi; children: ReactNode }) {
  const [load] = useState(() => linkBatcher((urls) => api.resolveGithubLinks(urls)));
  const render = useCallback(
    (href: string, label: string) =>
      githubItemOf(href) ? <GitHubLink href={href} label={label} load={load} /> : undefined,
    [load],
  );

  return <MarkdownLinks.Provider value={render}>{children}</MarkdownLinks.Provider>;
}

const methodNames: Record<GitHubMergeMethod, { action: string; detail: string }> = {
  merge: { action: 'Merge', detail: 'with a merge commit' },
  squash: { action: 'Squash and merge', detail: 'as one squashed commit' },
  rebase: { action: 'Rebase and merge', detail: 'with its commits rebased onto it' },
};

const mergeableNotes: Record<GitHubPull['mergeable'], string> = {
  clean: 'Ready to merge.',
  conflicts: 'This branch has conflicts with the base branch.',
  blocked: 'Merging is blocked by the repository’s rules or pending reviews.',
  behind: 'This branch is behind the base branch.',
  unknown: 'Checking whether it can merge…',
};

/** Seconds between two timestamps, read as a person says it: 3m 12s. */
function duration(from?: string, to?: string) {
  if (!from || !to) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);

  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function checkState(check: GitHubPull['checks']['runs'][number]) {
  if (check.status !== 'completed') return 'pending';
  return ['success', 'neutral', 'skipped'].includes(check.conclusion ?? '') ? 'passing' : 'failing';
}

/** A person on GitHub, by the name they go by there, linked to their profile. */
function Person({ login }: { login?: string }) {
  if (!login) return <span>Someone</span>;

  return (
    <a
      className="github-person"
      href={`https://github.com/${login}`}
      target="_blank"
      rel="noreferrer"
    >
      {login}
    </a>
  );
}

/** The title and what sits under it; the bar above it with its buttons stays put. */
function Header({ title, url, children }: { title: string; url: string; children?: ReactNode }) {
  return (
    <header>
      <h2 className="github-drawer-title">
        <a href={url} target="_blank" rel="noreferrer">
          {title}
        </a>
      </h2>
      {children}
    </header>
  );
}

function Author({ login, at }: { login?: string; at: string }) {
  return (
    <span className="github-author">
      <Person login={login} /> · {date(at)}
    </span>
  );
}

function MergeButton({
  pull,
  merge,
}: {
  pull: GitHubPull;
  merge: (method: GitHubMergeMethod) => void;
}) {
  const [method, setMethod] = useState<GitHubMergeMethod>(
    pull.mergeMethods.includes('squash') ? 'squash' : (pull.mergeMethods[0] ?? 'merge'),
  );
  const [open, setOpen] = useState(false);
  const blocked = pull.draft || pull.mergeable === 'conflicts' || !pull.mergeMethods.length;

  return (
    <div className="github-merge">
      <Button disabled={blocked} onClick={() => merge(method)}>
        <GitMerge size={16} aria-hidden="true" />
        {methodNames[method].action}
      </Button>
      {pull.mergeMethods.length > 1 && (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Trigger
            className={buttonClass('primary', 'github-merge-more')}
            aria-label="Merge method"
            disabled={blocked}
          >
            <ChevronDown size={16} aria-hidden="true" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              className="select-positioner"
              side="bottom"
              align="start"
              sideOffset={6}
              positionMethod="fixed"
            >
              <Popover.Popup className="model-menu" aria-label="Merge method">
                <fieldset>
                  <legend>Merge method</legend>
                  {pull.mergeMethods.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="model-option"
                      aria-pressed={item === method}
                      onClick={() => {
                        setMethod(item);
                        setOpen(false);
                      }}
                    >
                      <span className="model-option-name">
                        {methodNames[item].action}
                        <small>Lands {methodNames[item].detail}</small>
                      </span>
                      {item === method && <Check size={14} aria-hidden="true" />}
                    </button>
                  ))}
                </fieldset>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  );
}

type Pull = Pick<GitHubPull, 'owner' | 'repo' | 'number'>;

/** The mark a check, or the checks together, shows: passed, failed, or still running. */
function CheckMark({
  state,
  size = 14,
}: {
  state: 'passing' | 'failing' | 'pending';
  size?: number;
}) {
  return state === 'failing' ? (
    <X size={size} aria-hidden="true" />
  ) : state === 'pending' ? (
    <CircleDashed size={size} aria-hidden="true" />
  ) : (
    <Check size={size} aria-hidden="true" />
  );
}

const reviewNames: Record<GitHubPull['reviews']['latest'][number]['state'], string> = {
  approved: 'approved',
  changes_requested: 'requested changes',
  commented: 'reviewed',
  dismissed: 'had a review dismissed',
  pending: 'started a review',
};

/** Reviews and comments together, oldest first, as the pull request's conversation reads. */
function Activity({ pull }: { pull: GitHubPull }) {
  const entries = [
    ...pull.reviews.latest.map((review) => ({
      key: `review:${review.reviewer.login}`,
      login: review.reviewer.login,
      at: review.submittedAt,
      what: reviewNames[review.state],
      state: review.state as string,
      body: review.body,
    })),
    ...pull.comments.map((comment, index) => ({
      key: `comment:${index}`,
      login: comment.author?.login,
      at: comment.createdAt,
      what: 'commented',
      state: 'comment',
      body: comment.body,
    })),
  ].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));

  if (!entries.length) return <p className="github-none">No reviews or comments yet.</p>;

  return (
    <ol className="github-timeline">
      {entries.map((entry) => (
        <li key={entry.key} data-state={entry.state}>
          <span className="github-timeline-dot" aria-hidden="true" />
          <p className="github-timeline-head">
            <Person login={entry.login} /> {entry.what}
            {entry.at && <small>{date(entry.at)}</small>}
          </p>
          {entry.body?.trim() && (
            <div className="markdown github-markdown">
              <Markdown text={entry.body} />
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function PullView({
  api,
  pull,
  profileId,
  fixConflicts,
}: {
  api: DrawerApi;
  pull: GitHubPull;
  profileId: string;
  /** Where the panel answers the chat: it merges, and asks the agent to settle conflicts. */
  fixConflicts?: (pull: Pull) => Promise<unknown>;
}) {
  const client = useQueryClient();
  const [confirming, setConfirming] = useState<GitHubMergeMethod>();
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);
  const open = pull.state === 'open';
  const conflicts = open && pull.mergeable === 'conflicts';
  const runs = pull.checks.runs;
  const passed = runs.filter((check) => checkState(check) === 'passing').length;
  const checks = runs.some((check) => checkState(check) === 'failing')
    ? 'failing'
    : runs.some((check) => checkState(check) === 'pending')
      ? 'pending'
      : 'passing';
  const activity = pull.reviews.latest.length + pull.comments.length;

  const merge = async (method: GitHubMergeMethod) => {
    setBusy(true);
    try {
      const merged = await api.mergeGithubPull(pull.owner, pull.repo, pull.number, {
        method,
        expectedHeadSha: pull.head.sha,
        profileId,
      });
      toast.success(merged.message);
      // Merged at once, in the drawer and in every reference to it. Not read again: GitHub's
      // reads can still say open for a moment, and a merge never comes undone.
      client.setQueryData<GitHubPull>(
        keys.githubItem('pull', pull.owner, pull.repo, pull.number),
        (known) => (known ? { ...known, state: 'merged' } : known),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'GitHub did not merge it.');
      // Refused: the head moved or a rule stood in the way, so read where it stands now.
      await client.invalidateQueries({
        queryKey: keys.githubItem('pull', pull.owner, pull.repo, pull.number),
      });
    } finally {
      setBusy(false);
      setConfirming(undefined);
    }
  };

  const fix = async () => {
    if (!fixConflicts) return;
    setFixing(true);
    try {
      await fixConflicts(pull);
      toast.success('The agent is resolving the conflicts.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The agent could not be asked.');
    } finally {
      setFixing(false);
    }
  };

  return (
    <>
      <Header title={pull.title} url={pull.url}>
        <div className="github-meta">
          <StateChip state={pull.state} draft={pull.draft} />
          <Author login={pull.author?.login} at={pull.createdAt} />
        </div>
        <p className="github-branches">
          <code>{pull.base.ref}</code>
          <span aria-hidden="true">←</span>
          <span className="sr-only">from</span>
          <code>{pull.head.ref}</code>
        </p>
        {open && fixConflicts && (
          <div className="github-actions">
            {/* A branch in conflict cannot merge: what it needs instead takes the button's place. */}
            {conflicts ? (
              <Button busy={fixing} onClick={() => void fix()}>
                <Wrench size={16} aria-hidden="true" />
                Fix merge conflicts
              </Button>
            ) : (
              <MergeButton pull={pull} merge={setConfirming} />
            )}
          </div>
        )}
        {open && (
          <p className="github-mergeable" data-state={pull.mergeable}>
            {pull.draft
              ? 'A draft does not merge until it is marked ready.'
              : mergeableNotes[pull.mergeable]}
          </p>
        )}
      </Header>
      <Tabs.Root className="github-tabs" defaultValue="description">
        <Tabs.List className="github-tab-list" aria-label="Pull request">
          <Tabs.Tab className="github-tab" value="description">
            Description
          </Tabs.Tab>
          <Tabs.Tab className="github-tab" value="checks">
            {runs.length > 0 && (
              <span className="github-tab-mark" data-state={checks}>
                <CheckMark state={checks} size={13} />
              </span>
            )}
            Checks
            <span className="github-tab-count">{runs.length ? `${passed}/${runs.length}` : 0}</span>
          </Tabs.Tab>
          <Tabs.Tab className="github-tab" value="changes">
            Changes
            <span className="github-tab-count">{pull.changedFiles}</span>
          </Tabs.Tab>
          <Tabs.Tab className="github-tab" value="activity">
            Activity
            <span className="github-tab-count">{activity}</span>
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel className="crew-drawer-body github-body" value="description">
          {pull.body.trim() ? (
            <div className="markdown github-markdown">
              <Markdown text={pull.body} />
            </div>
          ) : (
            <p className="github-none">No description.</p>
          )}
        </Tabs.Panel>
        <Tabs.Panel className="crew-drawer-body github-body" value="checks">
          {runs.length ? (
            <ul className="github-check-list">
              {runs.map((check) => {
                const state = checkState(check);
                const took = duration(check.startedAt, check.completedAt);

                return (
                  <li key={check.name} data-state={state}>
                    <CheckMark state={state} />
                    {check.url ? (
                      <a href={check.url} target="_blank" rel="noreferrer">
                        {check.name}
                      </a>
                    ) : (
                      <span>{check.name}</span>
                    )}
                    <small>
                      {check.status === 'completed'
                        ? (check.conclusion ?? 'completed').replace(/_/g, ' ')
                        : check.status.replace(/_/g, ' ')}
                      {took ? ` · ${took}` : ''}
                    </small>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="github-none">No checks reported for this commit.</p>
          )}
        </Tabs.Panel>
        <Tabs.Panel className="crew-drawer-body github-body" value="changes">
          <p className="github-counts code-change-counts">
            <span className="added">+{pull.additions}</span>
            <span className="removed">−{pull.deletions}</span>
          </p>
          <div className="code-changes">
            {pull.files.map((file) =>
              file.diff ? (
                <FileDiff key={file.path} diff={file.diff} open={pull.files.length <= OPEN_FILES} />
              ) : (
                <p key={file.path} className="github-file-plain">
                  <span>{file.path}</span>
                  <small>No preview: binary or too large</small>
                </p>
              ),
            )}
          </div>
          {pull.filesTruncated && (
            <p className="github-none">Only the first {pull.files.length} files are shown here.</p>
          )}
        </Tabs.Panel>
        <Tabs.Panel className="crew-drawer-body github-body" value="activity">
          <Activity pull={pull} />
        </Tabs.Panel>
      </Tabs.Root>
      {confirming && (
        <Modal
          title={`${methodNames[confirming].action} #${pull.number}?`}
          description={`${pull.head.ref} lands on ${pull.base.ref} ${methodNames[confirming].detail}.`}
          close={() => setConfirming(undefined)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(undefined)}>
                Cancel
              </Button>
              <Button busy={busy} onClick={() => void merge(confirming)}>
                {methodNames[confirming].action}
              </Button>
            </>
          }
        />
      )}
    </>
  );
}

function IssueView({ issue }: { issue: GitHubIssue }) {
  return (
    <>
      <Header title={issue.title} url={issue.url}>
        <div className="github-meta">
          <StateChip state={issue.state} />
          <Author login={issue.author?.login} at={issue.createdAt} />
        </div>
        {issue.labels.length > 0 && (
          <ul className="github-labels" aria-label="Labels">
            {issue.labels.map((label) => (
              <li
                key={label.name}
                style={
                  /^[0-9a-f]{6}$/i.test(label.color)
                    ? ({ '--label': `#${label.color}` } as CSSProperties)
                    : undefined
                }
              >
                {label.name}
              </li>
            ))}
          </ul>
        )}
      </Header>
      <div className="crew-drawer-body github-body">
        {issue.assignees.length > 0 && (
          <section className="github-section">
            <h3>Assignees</h3>
            <p className="github-people">
              {issue.assignees.map((assignee) => (
                <Person key={assignee.login} login={assignee.login} />
              ))}
            </p>
          </section>
        )}
        {issue.body.trim() && (
          <div className="markdown github-markdown">
            <Markdown text={issue.body} />
          </div>
        )}
        <section className="github-section">
          <h3>
            Comments
            <span>{issue.comments.length}</span>
          </h3>
          {issue.comments.length ? (
            <ol className="github-comments">
              {issue.comments.map((comment, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: comments arrive in a fixed order.
                <li key={index}>
                  <Author login={comment.author?.login} at={comment.createdAt} />
                  <div className="markdown github-markdown">
                    <Markdown text={comment.body} />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="github-none">No comments.</p>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * The drawer's shape while GitHub answers: the title, where it stands, its branches and actions,
 * then its description, so the item fills in where its parts will be.
 */
function DrawerSkeleton() {
  return (
    <div className="github-skeleton" role="status" aria-label="Reading it from GitHub">
      <div className="github-skeleton-head">
        <span className="skeleton" style={{ width: '88%', height: '1.1rem' }} />
        <span className="skeleton" style={{ width: '55%', height: '1.1rem' }} />
        <span className="github-skeleton-row">
          <span className="skeleton" style={{ width: '3.25rem', height: '1.35rem' }} />
          <span className="skeleton" style={{ width: '9rem', height: '0.85rem' }} />
        </span>
        <span className="skeleton" style={{ width: '62%', height: '1.25rem' }} />
        <span className="github-skeleton-row">
          <span className="skeleton" style={{ width: '6.5rem', height: '2.25rem' }} />
          <span className="skeleton" style={{ width: '8.5rem', height: '2.25rem' }} />
        </span>
      </div>
      <div className="github-skeleton-body">
        {['94%', '100%', '86%', '72%', '0', '98%', '90%', '64%'].map((width, index) =>
          width === '0' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed shape, never reordered.
            <span key={index} className="github-skeleton-gap" />
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed shape, never reordered.
            <span key={index} className="skeleton" style={{ width, height: '0.8rem' }} />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * A pull request or an issue followed beside the conversation, in the Inspector. Without
 * `fixConflicts` the conversation is answered elsewhere, WhatsApp or Telegram, and the drawer
 * only reads, as its approvals do.
 */
export function GitHubDrawer({
  api,
  profileId,
  fixConflicts,
}: {
  api: DrawerApi;
  profileId: string;
  fixConflicts?: (pull: Pull) => Promise<unknown>;
}) {
  const client = useQueryClient();
  const item = useCrew((state) => state.item);
  const following = useCrew((state) => state.following);
  const close = useCrew((state) => state.close);
  const closer = useRef<HTMLButtonElement>(null);
  const issue = useQuery({
    queryKey: item ? keys.githubItem('issue', item.owner, item.repo, item.number) : ['none'],
    queryFn: () => api.githubIssue(item?.owner ?? '', item?.repo ?? '', item?.number ?? 0),
    enabled: item?.kind === 'issue',
  });
  // A link to an issue number GitHub answers as a pull request shows the pull request.
  const isPull = item?.kind === 'pull' || issue.data?.kind === 'pull';
  const pull = useQuery({
    queryKey: item ? keys.githubItem('pull', item.owner, item.repo, item.number) : ['none'],
    queryFn: () => api.githubPull(item?.owner ?? '', item?.repo ?? '', item?.number ?? 0),
    enabled: Boolean(item) && isPull,
    refetchInterval: (query) =>
      query.state.data?.state !== 'open'
        ? false
        : query.state.data.mergeable === 'unknown'
          ? MERGEABLE_RETRY_MS
          : OPEN_PULL_MS,
  });

  // What the drawer reads is the newest word on the pull request: every reference to it in the
  // conversation shows the same, the moment it arrives.
  useEffect(() => {
    const read = pull.data;
    if (!read) return;
    client.setQueriesData<GitHubLinkSummary>(
      { queryKey: ['integrations', 'github', 'links'] },
      (known) =>
        known?.reachable &&
        known.owner.toLowerCase() === read.owner.toLowerCase() &&
        known.repo.toLowerCase() === read.repo.toLowerCase() &&
        known.number === read.number
          ? {
              ...known,
              title: read.title,
              state: read.state,
              draft: read.draft,
              checks: read.checks.summary,
              mergeable: read.mergeable,
            }
          : known,
    );
  }, [client, pull.data]);

  useDrawerFocus(item ? following : undefined, closer);

  if (!item) return null;
  const current = isPull ? pull : issue;
  const where = `${item.owner}/${item.repo} #${item.number}`;
  const url = isPull
    ? `https://github.com/${item.owner}/${item.repo}/pull/${item.number}`
    : `https://github.com/${item.owner}/${item.repo}/issues/${item.number}`;

  return (
    <aside className="crew-drawer github-drawer" aria-label={where}>
      <div className="github-drawer-bar">
        <GitHubLogo size={18} />
        <span className="github-drawer-where">
          <span>{where}</span>
          <a
            className="github-drawer-out"
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open on GitHub"
            title="Open on GitHub"
          >
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh"
          title="Refresh"
          data-busy={current.isFetching || undefined}
          disabled={current.isFetching}
          onClick={() => void current.refetch()}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
        <button
          ref={closer}
          type="button"
          className="icon-button"
          aria-label="Close"
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      {isPull && pull.data ? (
        <PullView api={api} pull={pull.data} profileId={profileId} fixConflicts={fixConflicts} />
      ) : !isPull && issue.data ? (
        <IssueView issue={issue.data} />
      ) : current.error ? (
        <div className="crew-drawer-body">
          <p className="text-bad">
            {current.error instanceof Error ? current.error.message : 'GitHub did not answer.'}
          </p>
        </div>
      ) : (
        <DrawerSkeleton />
      )}
    </aside>
  );
}

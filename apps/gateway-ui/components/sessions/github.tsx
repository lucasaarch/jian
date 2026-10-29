'use client';

import { Popover } from '@base-ui/react/popover';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, CircleDashed, ExternalLink, GitMerge, Wrench, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button, buttonClass, Face, GitHubLogo, Modal } from '@/components/ui';
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

/** How long a card's summary is trusted before the next render asks again. */
const CARD_STALE_MS = 30_000;
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

type ChecksSummary = { passing: number; failing: number; pending: number };

function checksState(summary?: ChecksSummary) {
  if (!summary) return undefined;
  if (summary.failing) return 'failing' as const;
  if (summary.pending) return 'pending' as const;
  return summary.passing ? ('passing' as const) : undefined;
}

const checksNames = {
  failing: 'Checks failing',
  pending: 'Checks running',
  passing: 'Checks passing',
};

function ChecksMark({ summary }: { summary?: ChecksSummary }) {
  const state = checksState(summary);

  if (!state) return null;
  return (
    <span className="github-checks" data-state={state} title={checksNames[state]}>
      {state === 'failing' ? (
        <X size={13} aria-hidden="true" />
      ) : state === 'pending' ? (
        <CircleDashed size={13} aria-hidden="true" />
      ) : (
        <Check size={13} aria-hidden="true" />
      )}
      <span className="sr-only">{checksNames[state]}</span>
    </span>
  );
}

/** A link to a pull request or an issue, shown as what it is. Clicking follows it in the drawer. */
function GitHubCard({ summary, href }: { summary: Reachable; href: string }) {
  const open = useCrew((state) => state.open);
  const close = useCrew((state) => state.close);
  const following = useCrew((state) => state.following);
  const item: GitHubItem = { ...summary, url: href };
  const followed = following === itemKey(item);

  return (
    <button
      type="button"
      className="github-card"
      aria-pressed={followed}
      onClick={(event) => (followed ? close() : open(item, event.currentTarget))}
    >
      <GitHubLogo size={15} className="github-card-mark" />
      <span className="github-card-where">
        {summary.owner}/{summary.repo}
      </span>
      <span className="github-card-number">#{summary.number}</span>
      <span className="github-card-title">{summary.title}</span>
      <StateChip state={summary.state} draft={summary.draft} />
      {summary.kind === 'pull' && <ChecksMark summary={summary.checks} />}
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

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="github-section">
      <h3>
        {title}
        {count !== undefined && <span>{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** The title and what sits under it; the bar above it with the close button stays put. */
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
      {login && <Face name={login} className="github-face" />}
      <span>
        {login ? <strong>{login}</strong> : 'Someone'} · {date(at)}
      </span>
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

function PullView({
  api,
  pull,
  profileId,
  send,
  onSent,
}: {
  api: DrawerApi;
  pull: GitHubPull;
  profileId: string;
  send?: (text: string) => Promise<unknown>;
  onSent?: () => void;
}) {
  const client = useQueryClient();
  const close = useCrew((state) => state.close);
  const [confirming, setConfirming] = useState<GitHubMergeMethod>();
  const [busy, setBusy] = useState(false);
  const open = pull.state === 'open';

  const merge = async (method: GitHubMergeMethod) => {
    setBusy(true);
    try {
      const merged = await api.mergeGithubPull(pull.owner, pull.repo, pull.number, {
        method,
        expectedHeadSha: pull.head.sha,
        profileId,
      });
      toast.success(merged.message);
      setConfirming(undefined);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'GitHub did not merge it.');
      setConfirming(undefined);
    } finally {
      setBusy(false);
      await Promise.all([
        client.invalidateQueries({
          queryKey: keys.githubItem('pull', pull.owner, pull.repo, pull.number),
        }),
        client.invalidateQueries({ queryKey: ['integrations', 'github', 'links'] }),
      ]);
    }
  };

  const fix = async () => {
    if (!send) return;
    setBusy(true);
    try {
      await send(`Resolve the merge conflicts in ${pull.url} and push the fix.`);
      onSent?.();
      close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The message was not sent.');
    } finally {
      setBusy(false);
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
        <div className="github-actions">
          {open && send && <MergeButton pull={pull} merge={setConfirming} />}
          {open && send && pull.mergeable === 'conflicts' && (
            <Button variant="secondary" busy={busy && !confirming} onClick={() => void fix()}>
              <Wrench size={16} aria-hidden="true" />
              Fix conflicts
            </Button>
          )}
          <a className={buttonClass('secondary')} href={pull.url} target="_blank" rel="noreferrer">
            <ExternalLink size={16} aria-hidden="true" />
            Open on GitHub
          </a>
        </div>
        {open && (
          <p className="github-mergeable" data-state={pull.mergeable}>
            {pull.draft
              ? 'A draft does not merge until it is marked ready.'
              : mergeableNotes[pull.mergeable]}
          </p>
        )}
      </Header>
      <div className="crew-drawer-body github-body">
        {pull.body.trim() && (
          <div className="markdown github-markdown">
            <Markdown text={pull.body} />
          </div>
        )}
        <Section title="Checks" count={pull.checks.runs.length}>
          {pull.checks.runs.length ? (
            <ul className="github-check-list">
              {pull.checks.runs.map((check) => {
                const state = checkState(check);
                const took = duration(check.startedAt, check.completedAt);

                return (
                  <li key={check.name} data-state={state}>
                    {state === 'failing' ? (
                      <X size={14} aria-hidden="true" />
                    ) : state === 'pending' ? (
                      <CircleDashed size={14} aria-hidden="true" />
                    ) : (
                      <Check size={14} aria-hidden="true" />
                    )}
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
        </Section>
        <Section title="Reviews" count={pull.reviews.latest.length}>
          {pull.reviews.latest.length ? (
            <ul className="github-review-list">
              {pull.reviews.latest.map((review) => (
                <li key={review.reviewer.login} data-state={review.state}>
                  <Face name={review.reviewer.login} className="github-face" />
                  <strong>{review.reviewer.login}</strong>
                  <small>{review.state.replace(/_/g, ' ')}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="github-none">No reviews yet.</p>
          )}
        </Section>
        <Section title="Files changed" count={pull.changedFiles}>
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
        </Section>
      </div>
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
        <div className="github-actions">
          <a className={buttonClass('secondary')} href={issue.url} target="_blank" rel="noreferrer">
            <ExternalLink size={16} aria-hidden="true" />
            Open on GitHub
          </a>
        </div>
      </Header>
      <div className="crew-drawer-body github-body">
        {issue.assignees.length > 0 && (
          <Section title="Assignees">
            <ul className="github-review-list">
              {issue.assignees.map((assignee) => (
                <li key={assignee.login}>
                  <Face name={assignee.login} className="github-face" />
                  <strong>{assignee.login}</strong>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {issue.body.trim() && (
          <div className="markdown github-markdown">
            <Markdown text={issue.body} />
          </div>
        )}
        <Section title="Comments" count={issue.comments.length}>
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
        </Section>
      </div>
    </>
  );
}

/**
 * A pull request or an issue followed beside the conversation, in the agents' drawer. Without
 * `send` the conversation is answered elsewhere, WhatsApp or Telegram, and the drawer only reads,
 * as its approvals do.
 */
export function GitHubDrawer({
  api,
  profileId,
  send,
  onSent,
}: {
  api: DrawerApi;
  profileId: string;
  send?: (text: string) => Promise<unknown>;
  onSent?: () => void;
}) {
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
      query.state.data?.state === 'open' && query.state.data.mergeable === 'unknown'
        ? MERGEABLE_RETRY_MS
        : false,
  });

  useDrawerFocus(item ? following : undefined, closer);

  if (!item) return null;
  const current = isPull ? pull : issue;
  const where = `${item.owner}/${item.repo} #${item.number}`;

  return (
    <aside className="crew-drawer github-drawer" aria-label={where}>
      <div className="github-drawer-bar">
        <GitHubLogo size={18} />
        <span>{where}</span>
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
        <PullView api={api} pull={pull.data} profileId={profileId} send={send} onSent={onSent} />
      ) : !isPull && issue.data ? (
        <IssueView issue={issue.data} />
      ) : (
        <div className="crew-drawer-body">
          {current.error ? (
            <p className="text-bad">
              {current.error instanceof Error ? current.error.message : 'GitHub did not answer.'}
            </p>
          ) : (
            <p className="github-none">Reading it from GitHub…</p>
          )}
        </div>
      )}
    </aside>
  );
}

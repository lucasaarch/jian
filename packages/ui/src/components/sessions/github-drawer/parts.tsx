'use client';

import { Check, CircleDashed, ExternalLink, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Fold, FoldChevron, StatusPill, type StatusTone } from '../../../kit';
import { date } from '../../../lib/format';
import { Markdown } from '../../ui/markdown';
import { useFoldAll } from '../fold-all';

type Standing = 'open' | 'closed' | 'merged';

const standings: Record<Standing | 'draft', { name: string; tone: StatusTone }> = {
  open: { name: 'Open', tone: 'good' },
  draft: { name: 'Draft', tone: 'quiet' },
  merged: { name: 'Merged', tone: 'merged' },
  closed: { name: 'Closed', tone: 'bad' },
};

/** Where a pull request or an issue stands, in GitHub's own colours. A draft is its own word. */
function StatePill({ state, draft = false }: { state: Standing; draft?: boolean }) {
  const { name, tone } = standings[draft && state === 'open' ? 'draft' : state];
  return <StatusPill tone={tone}>{name}</StatusPill>;
}

/** A person on GitHub, by the name they go by there, linked to their profile. */
export function Person({ login }: { login?: string }) {
  if (!login) return <span>Someone</span>;

  return (
    <a
      className="font-medium text-ink underline-offset-2 hover:underline"
      href={`https://github.com/${login}`}
      target="_blank"
      rel="noreferrer"
    >
      {login}
    </a>
  );
}

/** Who opened it and when, after where it stands. */
export function Byline({
  state,
  draft,
  login,
  at,
}: {
  state: Standing;
  draft?: boolean;
  login?: string;
  at: string;
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <StatePill state={state} {...(draft ? { draft } : {})} />
      <span className="min-w-0">
        <Person login={login} /> · {date(at)}
      </span>
    </p>
  );
}

const line = 'group -mx-2.5 flex h-9 min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-[13px]';

/**
 * A line of a part that may open on GitHub: the whole line is the link, lit as it is pointed at,
 * its way out shown only then. Without a link it is the same line, still.
 */
export function LinkLine({ href, children }: { href?: string | undefined; children: ReactNode }) {
  if (!href) return <div className={line}>{children}</div>;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`${line} transition-colors hover:bg-glass-hover focus-visible:bg-glass-hover`}
    >
      {children}
      <ExternalLink
        size={12}
        aria-hidden="true"
        className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </a>
  );
}

/** Text written on GitHub, drawn as GitHub would; none at all is said so. */
export function Written({ text, none }: { text: string; none: string }) {
  return text.trim() ? (
    <div className="markdown github-markdown">
      <Markdown text={text} />
    </div>
  ) : (
    <Quiet>{none}</Quiet>
  );
}

/** What an empty part says instead of what it would hold. */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-muted">{children}</p>;
}

/**
 * One part of an item, under a heading that folds it, eased as the sidebar's sections are. What
 * it holds is counted at the heading's end, so a folded part still says how it stands.
 */
export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const id = useId();
  useFoldAll(setOpen);

  return (
    <section
      aria-label={title} // The side room is inside each piece, not around them: a line lit on hover reaches past the
      // text it holds without the fold, which clips what overflows it, cutting it off.
      className="border-t border-glass-edge py-3 first:border-t-0"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="group flex w-full items-center gap-1.5 px-5 rounded-md py-1 text-left text-[13px] font-medium text-ink outline-none"
      >
        {title}
        <FoldChevron
          open={open}
          className="text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
        {count && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs font-normal tabular-nums text-muted">
            {count}
          </span>
        )}
      </button>
      <Fold open={open} id={id}>
        <div className="grid min-w-0 gap-2 px-5 pt-2">{children}</div>
      </Fold>
    </section>
  );
}

export type CheckState = 'passing' | 'failing' | 'pending';

const checkColours: Record<CheckState, string> = {
  passing: 'text-good',
  failing: 'text-bad',
  pending: 'text-warn',
};

/** The mark a check, or the checks together, shows: passed, failed, or still running. */
export function CheckMark({ state, size = 14 }: { state: CheckState; size?: number }) {
  const Mark = state === 'failing' ? X : state === 'pending' ? CircleDashed : Check;
  return <Mark size={size} aria-hidden="true" className={`shrink-0 ${checkColours[state]}`} />;
}

const bar = 'block rounded-md bg-ink/7 animate-pulse motion-reduce:animate-none';

/**
 * The drawer's shape while GitHub answers: the title, where it stands, its branches, then its
 * description, so the item fills in where its parts will be.
 */
export function DrawerSkeleton() {
  return (
    <div role="status" aria-label="Reading it from GitHub" className="grid gap-6 px-5 pt-2">
      <div className="grid gap-2.5">
        <span className={`${bar} h-4.5 w-[88%]`} />
        <span className={`${bar} h-4.5 w-[55%]`} />
        <span className="flex items-center gap-2 pt-1">
          <span className={`${bar} h-5 w-12 rounded-full`} />
          <span className={`${bar} h-3 w-36`} />
        </span>
        <span className={`${bar} h-5 w-[62%]`} />
      </div>
      <div className="grid gap-2.5">
        {['92%', '78%', '85%', '40%'].map((width) => (
          <span key={width} className={`${bar} h-3`} style={{ width }} />
        ))}
      </div>
    </div>
  );
}

'use client';

import { ArrowUpRight } from 'lucide-react';
import { useId, useState } from 'react';
import { Markdown } from '../../components/ui/markdown';
import { Fold, FoldChevron } from '../../kit';
import type { AppUpdateRelease } from './app-update';

/** major.minor of a release, which the app and every gateway it uses must share. */
const lineOf = (version: string) => /^(\d+\.\d+)\./.exec(version)?.[1];

/**
 * What the new release brings: its summary, the whole note folded beneath, and a word about
 * gateways when it starts another major.minor, since the app then works only with that line.
 */
export function ReleaseDetails({ release }: { release: AppUpdateRelease }) {
  const [open, setOpen] = useState(false);
  const notes = useId();
  const line = lineOf(release.version);
  return (
    <section className="grid gap-3 rounded-2xl border border-glass-edge bg-glass-hover p-4">
      {release.summary && <p className="text-sm leading-relaxed text-ink">{release.summary}</p>}
      {release.newLine && line && (
        <p className="rounded-xl bg-warn-soft px-3 py-2 text-[13px] leading-snug text-warn">
          Jian {line} works with gateways on {line}. This computer’s gateway moves with the app;
          update your servers too, to keep using them here.
        </p>
      )}
      {/* One block with its fold, so a folded note leaves no gap behind. */}
      <div>
        <div className="flex items-center justify-between gap-3 text-[13px]">
          {release.notes ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={notes}
              onClick={() => setOpen(!open)}
              className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 font-medium text-muted transition-colors hover:text-ink"
            >
              <FoldChevron open={open} />
              Release notes
            </button>
          ) : (
            <span />
          )}
          <a
            href={release.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-muted transition-colors hover:text-ink"
          >
            On GitHub
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </div>
        {release.notes && (
          <Fold open={open} id={notes}>
            <div className="release-notes mt-3 max-h-56 overflow-y-auto border-t border-glass-edge pt-3 pr-1">
              <Markdown text={release.notes} />
            </div>
          </Fold>
        )}
      </div>
    </section>
  );
}

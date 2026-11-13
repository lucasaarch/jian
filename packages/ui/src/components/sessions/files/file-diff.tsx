'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { CodeDiff, GatewayApi } from '../../../lib/api';
import { keys } from '../../../lib/query/keys';
import { highlightLines, type Segment } from '../../ui/highlight';
import { coloured } from '../code-change';
import { DiffLine, markChanges } from '../diff-lines';

type Line = CodeDiff['hunks'][number]['lines'][number];
type Row = { line: Pick<Line, 'kind' | 'old' | 'new'>; segments: Segment[] };

/** Past this many lines the file around the changes is drawn without colours, as the viewer does. */
const HIGHLIGHT_LINES = 10_000;

/**
 * The whole file with its changes laid in: every line as it is now, and the removed ones where
 * they were. The lines come from the same read as the diff, so the two cannot disagree. A diff
 * cut short ends at its last hunk, since what follows may hold changes it does not show.
 */
export function wholeRows(diff: CodeDiff, file: string[]): Row[] {
  const plain = file.length > HIGHLIGHT_LINES ? undefined : diff.language;
  const around = highlightLines(file.join('\n'), plain);
  const rows: Row[] = [];
  let next = 1;
  const upTo = (end: number) => {
    for (; next < end; next += 1) {
      rows.push({ line: { kind: 'context', new: next }, segments: around[next - 1] ?? [] });
    }
  };
  for (const hunk of diff.hunks) {
    // A hunk with no lines on the new side names the line it comes after, as git writes it.
    const start = hunk.newLines ? hunk.newStart : hunk.newStart + 1;
    upTo(start);
    const painted = markChanges(hunk.lines, coloured(hunk.lines, diff.language));
    hunk.lines.forEach((line, index) => {
      rows.push({ line, segments: painted[index] ?? [] });
    });
    next = start + hunk.newLines;
  }
  if (!diff.truncated) upTo(file.length + 1);
  return rows;
}

/**
 * The open file as its uncommitted change left it, in the viewer's place, read from the checkout
 * Changes reads: the project, or the worktree the file is in. `version` is when the viewer last
 * read the file, so the diff is read again whenever the file is.
 */
export function FileDiffView({
  api,
  profileId,
  sessionId,
  root,
  path,
  wrap,
  version,
}: {
  api: Pick<GatewayApi, 'sessionChanges'>;
  profileId: string;
  sessionId: string;
  root: string;
  path: string;
  wrap: boolean;
  version: number;
}) {
  const worktree = root.startsWith('worktree:') ? root.slice('worktree:'.length) : undefined;
  const read = useQuery({
    queryKey: [...keys.sessionChanges(profileId, sessionId, path, worktree), 'whole', version],
    queryFn: () => api.sessionChanges(profileId, sessionId, path, true, worktree),
    // The last diff stays on screen while the next is read, so following the agent never blinks.
    placeholderData: (previous) => previous,
  });
  const change = read.data?.files[0];
  const rows = useMemo(
    () => (change?.diff ? wholeRows(change.diff, change.lines ?? []) : []),
    [change],
  );

  if (read.isError && !read.data) {
    return (
      <p role="alert" className="px-6 pt-4 text-sm text-muted">
        {read.error instanceof Error ? read.error.message : 'The diff could not be read.'}
      </p>
    );
  }
  if (!change) {
    return (
      <p role="status" className="px-6 pt-4 text-sm text-muted">
        Reading the diff…
      </p>
    );
  }
  if (!change.diff) {
    return (
      <p className="px-6 pt-4 text-sm text-muted">
        {change.unavailable ?? 'This file has no text diff.'}
      </p>
    );
  }

  return (
    <div className="code-diff file-diff" data-flat data-wrap={wrap || undefined}>
      <div className="code-diff-lines">
        {rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions in the file, never reordered.
          <DiffLine key={index} line={row.line} segments={row.segments} />
        ))}
      </div>
      {change.diff.truncated && (
        <p className="code-diff-cut">The rest of this change is too long to show here.</p>
      )}
    </div>
  );
}

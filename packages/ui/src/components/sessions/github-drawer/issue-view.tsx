'use client';

import type { CSSProperties } from 'react';
import type { GitHubIssue } from '../../../lib/api';
import { date } from '../../../lib/format';
import { InspectorBody, InspectorHeader } from '../inspector';
import { Byline, Person, Quiet, Section, Written } from './parts';

/** A label in its own colour, mixed toward the surface so any colour GitHub allows reads. */
function labelColours(color: string): CSSProperties | undefined {
  if (!/^[0-9a-f]{6}$/i.test(color)) return undefined;
  const label = `#${color}`;
  return {
    background: `color-mix(in srgb, ${label} 18%, var(--surface))`,
    borderColor: `color-mix(in srgb, ${label} 45%, var(--surface))`,
    color: `color-mix(in srgb, ${label} 55%, var(--ink))`,
  };
}

/** An issue: where it stands and its labels, then its description, assignees and comments. */
export function IssueView({ issue }: { issue: GitHubIssue }) {
  return (
    <>
      <InspectorHeader title={issue.title}>
        <Byline state={issue.state} login={issue.author?.login} at={issue.createdAt} />
        {issue.labels.length > 0 && (
          <ul aria-label="Labels" className="flex flex-wrap gap-1.5">
            {issue.labels.map((label) => (
              <li
                key={label.name}
                className="rounded-full border border-glass-edge bg-ink/6 px-2 py-px text-xs font-medium text-muted"
                style={labelColours(label.color)}
              >
                {label.name}
              </li>
            ))}
          </ul>
        )}
      </InspectorHeader>
      <InspectorBody>
        <Section title="Description">
          <Written text={issue.body} none="No description." />
        </Section>
        {issue.assignees.length > 0 && (
          <Section title="Assignees" count={issue.assignees.length}>
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
              {issue.assignees.map((assignee) => (
                <Person key={assignee.login} login={assignee.login} />
              ))}
            </p>
          </Section>
        )}
        <Section title="Comments" count={issue.comments.length}>
          {issue.comments.length ? (
            <ol aria-label="Comments" className="grid gap-3">
              {issue.comments.map((comment) => (
                <li
                  // A comment has no id of its own; who wrote it and when tells them apart.
                  key={`${comment.author?.login ?? ''}@${comment.createdAt}`}
                  className="grid gap-1.5 rounded-xl border border-glass-edge px-3.5 py-3"
                >
                  <span className="text-xs text-muted">
                    <Person login={comment.author?.login} /> · {date(comment.createdAt)}
                  </span>
                  <Written text={comment.body} none="Nothing written." />
                </li>
              ))}
            </ol>
          ) : (
            <Quiet>No comments.</Quiet>
          )}
        </Section>
      </InspectorBody>
    </>
  );
}

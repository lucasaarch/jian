'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { sourceLabel } from '../../components/skills/origin';
import type { SkillItem } from '../../components/skills/skill-items';
import { InfoTip } from '../../kit';
import { LOCALE } from '../../lib/format';
import { queries } from '../../lib/query/profile';
import { VerifiedBadge } from './plugin-list';

const day = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const dayOfYear = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const month = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' });

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 content-start gap-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-ink">
        {children}
      </dd>
    </div>
  );
}

/**
 * What is known about a skill beside what it says: who made it, whether the agents are offered
 * it, where it was copied from, which version the library holds and since when. A column at the
 * right of the page, and two under it where the page is narrow. `updates` is drawn for a skill
 * with a source, by the page, which holds what updating needs.
 */
export function SkillDetails({ item, updates }: { item: SkillItem; updates?: ReactNode }) {
  const builtIn = item.kind === 'built-in';
  // A built-in skill is as old as the Jian that ships it. A development build has no version.
  const jian = useQuery({ ...queries.gateway(), enabled: builtIn }).data?.version;
  const held = item.held;
  const origin = held?.origin;

  return (
    <dl
      aria-label="Details"
      className="grid grid-cols-1 content-start gap-x-8 gap-y-5 @max-[44rem]:grid-cols-2 @max-[26rem]:grid-cols-1"
    >
      <Detail label="Made by">
        {item.maker}
        {builtIn && <VerifiedBadge />}
      </Detail>
      <Detail label="Status">{item.enabled ? 'On for every agent' : 'Off'}</Detail>
      <Detail label="Access">
        Adds instructions only
        <InfoTip label="About access">
          A skill is text the agents read when a task calls for it. It runs nothing by itself.
        </InfoTip>
      </Detail>
      {origin ? (
        <Detail label="Source">
          <a
            href={origin.url}
            target="_blank"
            rel="noreferrer"
            className="text-link min-w-0 underline decoration-ink/25 [overflow-wrap:anywhere]"
          >
            {sourceLabel(origin.url)}
            {/* In the line, after its last word, however the address wraps. */}
            <ExternalLink size={12} aria-hidden="true" className="ml-1 inline align-[-1px]" />
          </a>
        </Detail>
      ) : (
        builtIn && <Detail label="Source">Ships with Jian</Detail>
      )}
      {held ? (
        <Detail label="Version">
          <span>
            v{held.version}{' '}
            <span className="text-muted">
              · updated {day.format(new Date(held.updatedAt))}
              {origin?.ref && ` · from ${origin.ref}`}
            </span>
          </span>
        </Detail>
      ) : (
        jian && <Detail label="Version">Jian {jian}</Detail>
      )}
      {updates && <Detail label="Updates">{updates}</Detail>}
      {origin?.license && <Detail label="License">{origin.license}</Detail>}
      {origin ? (
        <Detail label="Imported">{dayOfYear.format(new Date(origin.importedAt))}</Detail>
      ) : (
        held && <Detail label="Added">{month.format(new Date(held.createdAt))}</Detail>
      )}
    </dl>
  );
}

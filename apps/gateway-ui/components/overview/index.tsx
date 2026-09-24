'use client';

import { ArrowUpRight, Settings2 } from 'lucide-react';
import Link from 'next/link';
import type { GatewayApi, Profile, ProfileData } from '../../lib/api';
import { Avatar } from '../profile/avatar-field';
import { CountUp, SectionHeading } from '../ui';
import { ActivityHeatmap } from './heatmap';

export function Overview({
  profile,
  data,
  api,
}: {
  profile: Profile;
  data: ProfileData;
  api: GatewayApi;
}) {
  const active = data.activities.filter((run) => ['running', 'queued'].includes(run.status)).length;
  const total = (
    read: (usage: NonNullable<ProfileData['activities'][number]['usage']>) => number,
  ) => data.activities.reduce((sum, run) => sum + (run.usage ? read(run.usage) : 0), 0);

  const input = total((usage) => usage.inputTokens);
  const output = total((usage) => usage.outputTokens);
  // Served from the provider's cache: part of the input, and billed differently by every
  // provider that reports it, so it is shown apart instead of inside one number.
  const cached = total((usage) => usage.cachedInputTokens ?? 0);
  const estimated = data.activities.some((run) => run.usage?.estimated);
  return (
    <>
      <SectionHeading
        title="Overview"
        action={
          <span className="overview-live">
            <span className="live-dot" />
            {active ? `${active} running` : 'Nothing running'}
          </span>
        }
      />
      <section className="overview-profile" aria-label="Profile in use">
        <div className="flex min-w-0 items-center gap-5">
          <Avatar name={profile.name} avatar={profile.avatar} className="profile-avatar" />
          <h2>{profile.name}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/identity" className="button quiet">
            <Settings2 size={16} />
            Edit profile
          </Link>
        </div>
      </section>
      <section className="overview-metrics" aria-label="Profile activity">
        {[
          {
            label: 'Sessions',
            value: data.sessions.length,
            href: '/sessions',
            detail: 'Belonging to this profile',
          },
          {
            label: 'Memories',
            value: data.memories.length,
            href: '/memories',
            detail: 'Knowledge it kept',
          },
          {
            label: 'Runs',
            value: data.activities.length,
            href: '/sessions',
            detail: 'Of the last hundred',
          },
          {
            label: 'Channels',
            value: data.channels.filter((channel) => !channel.revokedAt).length,
            href: '/channels',
            detail: 'Where it can be reached',
          },
        ].map((item) => (
          <Link href={item.href} className="overview-metric" key={item.label}>
            <span>
              {item.label}
              <ArrowUpRight size={15} />
            </span>
            <strong>
              <CountUp value={item.value} />
            </strong>
            <small>{item.detail}</small>
          </Link>
        ))}
      </section>
      <div className="overview-columns">
        <ActivityHeatmap profile={profile} api={api} />
        <section className="usage-panel" aria-label="Token usage">
          <span className="eyebrow">Usage</span>
          <h2>
            <CountUp value={input + output} duration={1.6} />
            <small>tokens</small>
          </h2>
          <p>Counted across the last hundred runs</p>
          <div className="usage-bar" aria-hidden="true">
            <span style={{ width: `${input + output ? (input / (input + output)) * 100 : 0}%` }} />
            <span style={{ width: `${input + output ? (output / (input + output)) * 100 : 0}%` }} />
          </div>
          <dl>
            <div>
              <dt>
                <span className="usage-dot" />
                Input
              </dt>
              <dd>
                <CountUp value={input} />
              </dd>
            </div>
            <div>
              <dt>
                <span className="usage-dot output" />
                Output
              </dt>
              <dd>
                <CountUp value={output} />
              </dd>
            </div>
            {cached > 0 && (
              <div>
                <dt>
                  <span className="usage-dot cached" />
                  Read from cache
                </dt>
                <dd>
                  <CountUp value={cached} />
                </dd>
              </div>
            )}
          </dl>
          <p className="usage-footnote">
            {input + output
              ? 'The context sent and the answers generated. Providers price these differently, and cached input differently again, so this is a count and not a bill.'
              : 'Usage is recorded when a model reports it.'}
            {estimated && ' Some runs reported nothing and were counted here instead.'}
          </p>
        </section>
      </div>
    </>
  );
}

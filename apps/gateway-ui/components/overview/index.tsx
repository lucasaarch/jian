'use client';

import { ArrowUpRight, Settings2 } from 'lucide-react';
import Link from 'next/link';
import type { GatewayApi, Profile, ProfileData } from '../../lib/api';
import { Avatar } from '../profile/avatar-field';
import { SectionHeading } from '../ui';
import { ActivityHeatmap } from './heatmap';

const number = (value: number) => value.toLocaleString('pt-BR');
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
  const input = data.activities.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0), 0);
  const output = data.activities.reduce((sum, run) => sum + (run.usage?.outputTokens ?? 0), 0);
  const _recent = [...data.activities]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
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
      <section className="overview-metrics" aria-label="Atividade do perfil">
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
            <strong>{number(item.value)}</strong>
            <small>{item.detail}</small>
          </Link>
        ))}
      </section>
      <div className="overview-columns">
        <ActivityHeatmap profile={profile} api={api} />
        <section className="usage-panel" aria-label="Token usage">
          <span className="eyebrow">Usage</span>
          <h2>
            {number(input + output)}
            <small>tokens</small>
          </h2>
          <p>Across the last hundred runs</p>
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
              <dd>{number(input)}</dd>
            </div>
            <div>
              <dt>
                <span className="usage-dot output" />
                Output
              </dt>
              <dd>{number(output)}</dd>
            </div>
          </dl>
          <p className="usage-footnote">
            {input + output
              ? 'Counts the context sent and the answers generated.'
              : 'Usage is recorded when a model reports it.'}
          </p>
        </section>
      </div>
    </>
  );
}

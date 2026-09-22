'use client';

import { Activity, ArrowRight, ArrowUpRight, Settings2 } from 'lucide-react';
import Link from 'next/link';
import type { Profile, ProfileData } from '../../lib/api';
import { date } from '../../lib/format';
import { Avatar } from '../profile/avatar-field';
import { Badge, SectionHeading } from '../ui';

const number = (value: number) => value.toLocaleString('pt-BR');
export function Overview({ profile, data }: { profile: Profile; data: ProfileData }) {
  const active = data.activities.filter((run) => ['running', 'queued'].includes(run.status)).length;
  const input = data.activities.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0), 0);
  const output = data.activities.reduce((sum, run) => sum + (run.usage?.outputTokens ?? 0), 0);
  const recent = [...data.activities]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  return (
    <>
      <SectionHeading
        title="Visão geral"
        action={
          <span className="overview-live">
            <span className="live-dot" />
            {active ? `${active} em execução` : 'Nenhuma execução ativa'}
          </span>
        }
      />
      <section className="overview-profile" aria-label="Perfil em uso">
        <div className="flex min-w-0 items-center gap-5">
          <Avatar name={profile.name} avatar={profile.avatar} className="profile-avatar" />
          <h2>{profile.name}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/identity" className="button quiet">
            <Settings2 size={16} />
            Editar perfil
          </Link>
        </div>
      </section>
      <section className="overview-metrics" aria-label="Atividade do perfil">
        {[
          {
            label: 'Sessões',
            value: data.sessions.length,
            href: '/sessions',
            detail: 'Sessões do perfil',
          },
          {
            label: 'Memórias',
            value: data.memories.length,
            href: '/memories',
            detail: 'Conhecimento preservado',
          },
          {
            label: 'Execuções',
            value: data.activities.length,
            href: '/sessions',
            detail: 'Nas últimas 100',
          },
          {
            label: 'Canais',
            value: data.channels.filter((channel) => !channel.revokedAt).length,
            href: '/channels',
            detail: 'Por onde ela é encontrada',
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
        <section className="overview-activity">
          <header className="section-row">
            <h2>Atividade recente</h2>
            <Link href="/sessions" className="text-button">
              Ver sessões
              <ArrowRight size={14} />
            </Link>
          </header>
          {recent.length ? (
            <div className="activity-list">
              {recent.map((run) => (
                <div className="activity-row" key={run.id}>
                  <Activity size={17} />
                  <div className="grow">
                    <h3>
                      {data.sessions.find((session) => session.id === run.sessionId)?.title ||
                        'Conversa sem título'}
                    </h3>
                    <p className="truncate">{run.input}</p>
                    <small>{date(run.updatedAt)}</small>
                  </div>
                  <Badge
                    tone={
                      run.status === 'completed'
                        ? 'good'
                        : ['failed', 'interrupted'].includes(run.status)
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {
                      {
                        queued: 'Na fila',
                        running: 'Em execução',
                        completed: 'Concluída',
                        failed: 'Falhou',
                        interrupted: 'Interrompida',
                        cancelled: 'Cancelada',
                      }[run.status]
                    }
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <div className="activity-empty">
              <Activity size={25} />
              <h3>Sem execuções recentes</h3>
              <p>As próximas atividades e seus resultados aparecerão aqui.</p>
            </div>
          )}
        </section>
        <section className="usage-panel" aria-label="Uso de tokens">
          <span className="eyebrow">Consumo</span>
          <h2>
            {number(input + output)}
            <small>tokens</small>
          </h2>
          <p>Nas últimas 100 execuções</p>
          <div className="usage-bar" aria-hidden="true">
            <span style={{ width: `${input + output ? (input / (input + output)) * 100 : 0}%` }} />
            <span style={{ width: `${input + output ? (output / (input + output)) * 100 : 0}%` }} />
          </div>
          <dl>
            <div>
              <dt>
                <span className="usage-dot" />
                Entrada
              </dt>
              <dd>{number(input)}</dd>
            </div>
            <div>
              <dt>
                <span className="usage-dot output" />
                Saída
              </dt>
              <dd>{number(output)}</dd>
            </div>
          </dl>
          <p className="usage-footnote">
            {input + output
              ? 'Inclui o contexto enviado e as respostas geradas.'
              : 'O consumo é registrado quando um modelo informa uso.'}
          </p>
        </section>
      </div>
    </>
  );
}

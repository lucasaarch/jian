'use client';

import { createContext, type RefObject, useContext, useEffect, useRef } from 'react';
import type { Message, ModelSelection, Subagent } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { Orb } from '../ui';
import { statusOf } from './progress';
import { statusLabels } from './status';
import { WorkMark } from './thought-line';

export const tierNames = { light: 'Light', standard: 'Standard', deep: 'Deep' } as const;

export const active = (agent: Subagent) => agent.status === 'queued' || agent.status === 'running';

/** A model id read as a name when the provider gave none: `claude-opus-5-5` as Claude Opus 5.5. */
export function prettyModel(id: string) {
  return id
    .split(/[-_]/)
    .reduce<string[]>((words, part) => {
      const previous = words.at(-1);
      // A version written in parts, 5-5, is read as one: 5.5.
      if (/^\d+$/.test(part) && previous && /^\d+(\.\d+)*$/.test(previous)) {
        words[words.length - 1] = `${previous}.${part}`;
      } else {
        words.push(/^gpt$/i.test(part) ? 'GPT' : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`);
      }
      return words;
    }, [])
    .join(' ');
}

/**
 * How the conversation names a model. The page that knows the providers' lists gives the name
 * each provider reports; without it the id is read as a name.
 */
export const ModelNames = createContext<(selection: ModelSelection) => string>((selection) =>
  prettyModel(selection.modelId),
);

/** Minutes and seconds from one moment to another, in ms since the epoch: 3:07. */
const between = (from: number, to: number) => {
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Minutes and seconds since the agent started, running while it works. */
export function Elapsed({
  agent,
  className = 'crew-time',
}: {
  agent: Subagent;
  className?: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const start = Date.parse(agent.createdAt);
  const working = active(agent);

  // Written straight into the text each second, so the card does not render for a clock.
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => {
      if (element.current) element.current.textContent = between(start, Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [working, start]);

  return (
    <span ref={element} className={className}>
      {between(start, working ? Date.now() : Date.parse(agent.updatedAt))}
    </span>
  );
}

/**
 * What the agent is on, or what stopped it, in one line. A finished agent has none: its check
 * says it is done, and its report is a click away in the drawer.
 */
export function nowOf(agent: Subagent) {
  if (agent.status === 'queued') return 'Waiting to start';
  if (agent.status === 'running') return statusOf(agent).label;
  if (agent.status === 'completed') return undefined;
  return agent.error ?? statusLabels[agent.status];
}

export function TierChip({ tier }: { tier?: Subagent['tier'] }) {
  if (!tier) return null;
  return (
    <span className="tier-chip" data-tier={tier}>
      <i aria-hidden="true" />
      {tierNames[tier]}
    </span>
  );
}

/** One agent this turn handed work to: who, on what model, doing what, for how long. */
function AgentCard({ agent }: { agent: Subagent }) {
  const following = useCrew((state) => state.following);
  const follow = useCrew((state) => state.follow);
  const close = useCrew((state) => state.close);
  const modelName = useContext(ModelNames);
  const working = active(agent);
  const failed = !working && agent.status !== 'completed';

  return (
    <button
      type="button"
      className="crew-card"
      data-tier={agent.tier}
      data-state={working ? 'working' : failed ? 'failed' : 'done'}
      aria-pressed={following === agent.runId}
      onClick={(event) =>
        following === agent.runId ? close() : follow(agent.runId, event.currentTarget)
      }
    >
      <span className="crew-card-top">
        <WorkMark working={working} failed={failed} orb={statusOf(agent).state} />
        <strong>{agent.name}</strong>
      </span>
      {nowOf(agent) && <span className="crew-now">{nowOf(agent)}</span>}
      <span className="crew-bar" aria-hidden="true" />
      <span className="crew-foot">
        <TierChip tier={agent.tier} />
        {agent.modelSelection && (
          <span className="crew-model">{modelName(agent.modelSelection)}</span>
        )}
        <Elapsed agent={agent} />
      </span>
    </button>
  );
}

/** The agents one turn handed work to, as cards inside that turn. */
export function CrewCards({ agents }: { agents: Subagent[] }) {
  if (!agents.length) return null;
  const working = agents.filter(active).length;

  return (
    <section className="crew" aria-label="Agents">
      <p className="crew-head">
        <strong>{agents.length === 1 ? '1 agent' : `${agents.length} agents`}</strong>
        <span>{working ? `${working} working · ${agents.length - working} done` : 'All done'}</span>
      </p>
      <div className="crew-cards">
        {agents.map((agent) => (
          <AgentCard key={agent.runId} agent={agent} />
        ))}
      </div>
    </section>
  );
}

/**
 * The gateway hands a finished agent's report back as a message in the conversation, written
 * for the agent that reads it: `Subagent "name" (role) finished.`, then `Run <id> status: …`.
 * It is the agent's mail, not the owner's words, and the agent's card already says it ended, so
 * the conversation does not show it. The run id ties it to an agent of this conversation; text
 * that only looks like a report stays a message.
 */
export function reportOf(message: Pick<Message, 'role' | 'content'>, agents: Subagent[]) {
  if (message.role !== 'user') return undefined;
  if (!/^Subagent "[^"\n]*" \((?:execute|review)\) finished\./.test(message.content)) {
    return undefined;
  }

  return agents.find((agent) => message.content.includes(`\nRun ${agent.runId} status: `));
}

/**
 * Above the composer while agents work, so they stay in sight once their turn has scrolled
 * away. It opens the first of them that is still working.
 */
export function CrewDock({ agents }: { agents: Subagent[] }) {
  const follow = useCrew((state) => state.follow);
  const working = agents.filter(active);

  if (!working.length) return null;

  return (
    <button
      type="button"
      className="crew-dock"
      onClick={(event) => follow(working[0]?.runId ?? '', event.currentTarget)}
    >
      <span className="crew-dock-orbs" aria-hidden="true">
        {working.slice(0, 3).map((agent) => (
          <Orb key={agent.runId} state={statusOf(agent).state} />
        ))}
      </span>
      <span>
        {working.length === 1 ? '1 agent working' : `${working.length} agents working`}
        {agents.length > working.length && ` · ${agents.length - working.length} done`}
      </span>
      <span className="crew-dock-go">Follow</span>
    </button>
  );
}

/**
 * In on open, and back to what opened it on close, so the keyboard does not lose its place.
 * Escape closes. `shown` is what the drawer shows, undefined while it shows nothing.
 */
export function useDrawerFocus(shown: string | undefined, closer: RefObject<HTMLElement | null>) {
  const close = useCrew((state) => state.close);

  useEffect(() => {
    if (!shown) return;
    closer.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', keys);

    return () => {
      document.removeEventListener('keydown', keys);
      useCrew.getState().opener?.focus({ preventScroll: true });
    };
  }, [shown, close, closer]);
}

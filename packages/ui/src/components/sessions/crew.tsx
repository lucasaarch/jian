'use client';

import { createContext, type RefObject, useContext, useEffect, useRef } from 'react';
import type { Message, ModelSelection, Subagent } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { statusOf } from './progress';
import { statusLabels } from './status';
import { WorkMark } from './thought-line';

const tierNames = { light: 'Light', standard: 'Standard', deep: 'Deep' } as const;

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
 * Every state keeps a single status line, including the outcome, so cards never shrink.
 */
function nowOf(agent: Subagent) {
  if (agent.status === 'queued') return 'Waiting to start';
  if (agent.status === 'running') return statusOf(agent).label;
  if (agent.status === 'completed') return 'Completed';
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
function AgentCard({ agent, index }: { agent: Subagent; index: number }) {
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
      style={{ animationDelay: `${Math.min(index, 4) * 40}ms` }}
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
      <span className="crew-now">{nowOf(agent)}</span>
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
        {agents.map((agent, index) => (
          <AgentCard key={agent.runId} agent={agent} index={index} />
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

/** A spawn belongs before the first answer written after it, never at a turn's arbitrary end. */
export function placeCrew(agents: Subagent[], answers: Message[]) {
  const before = new Map<string, Subagent[]>();
  const tail = new Map<string, Subagent[]>();
  for (const agent of agents) {
    const next = answers.find(
      (message) =>
        message.runId === agent.parentRunId &&
        Date.parse(message.createdAt) >= Date.parse(agent.createdAt),
    );
    const target = next ? before : tail;
    const key = next?.id ?? agent.parentRunId;
    target.set(key, [...(target.get(key) ?? []), agent]);
  }
  return { before, tail };
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

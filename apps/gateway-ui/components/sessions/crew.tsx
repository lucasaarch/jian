'use client';

import { X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Orb } from '@/components/ui';
import type { GatewayApi, Message, ModelSelection, Subagent, ToolStep } from '@/lib/api';
import { useCrew } from '@/lib/stores/crew';
import { plainText } from '../ui/markdown';
import { MessageMedia } from './media';
import { ChatMessage } from './message';
import { statusOf, traceOf } from './progress';
import { statusLabels } from './status';
import { ThoughtLine, WorkMark } from './thought-line';

const tierNames = { light: 'Light', standard: 'Standard', deep: 'Deep' } as const;

const active = (agent: Subagent) => agent.status === 'queued' || agent.status === 'running';

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

/** Minutes and seconds since the agent started, running while it works. */
function Elapsed({ agent }: { agent: Subagent }) {
  const element = useRef<HTMLSpanElement>(null);
  const start = Date.parse(agent.createdAt);
  const format = (to: number) => {
    const seconds = Math.max(0, Math.floor((to - start) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const working = active(agent);

  // biome-ignore lint/correctness/useExhaustiveDependencies: format reads only `start`.
  useEffect(() => {
    if (!working) return;
    const id = setInterval(() => {
      if (element.current) element.current.textContent = format(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [working, start]);

  return (
    <span ref={element} className="crew-time">
      {format(working ? Date.now() : Date.parse(agent.updatedAt))}
    </span>
  );
}

/** What the agent is on now, or how it ended, in one line. */
function nowOf(agent: Subagent) {
  if (agent.status === 'queued') return 'Waiting to start';
  if (agent.status === 'running') return statusOf(agent).label;
  if (agent.status === 'completed') {
    // The report is Markdown; one line of it reads as plain words.
    return (
      plainText(agent.output ?? '')
        .split('\n')
        .find((line) => line.trim())
        ?.trim() || 'Done'
    );
  }
  return agent.error ?? statusLabels[agent.status];
}

function TierChip({ tier }: { tier?: Subagent['tier'] }) {
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

const reasons = {
  agent: (tier: string) => `Chosen by the agent: ${tier}`,
  jev: (tier: string) => `Jev picked ${tier}`,
  default: (tier: string) => `${tier} by default`,
};

/**
 * One agent followed beside the conversation: what it is on, what it said and why it got its
 * model. The chat and the composer stay usable beside it; on a phone it is a sheet from below.
 */
export function CrewDrawer({
  api,
  profileId,
}: {
  api: Pick<GatewayApi, 'messages'> & Partial<Pick<GatewayApi, 'media' | 'timeline'>>;
  profileId: string;
}) {
  const following = useCrew((state) => state.following);
  const agent = useCrew((state) => state.agents.find((item) => item.runId === state.following));
  const close = useCrew((state) => state.close);
  const modelName = useContext(ModelNames);
  const [messages, setMessages] = useState<Message[]>();
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [error, setError] = useState('');
  const closer = useRef<HTMLButtonElement>(null);
  const working = agent ? active(agent) : false;
  const runId = agent?.runId;
  const place = agent?.sessionId;

  // In on open, and back to what opened it on close, so the keyboard does not lose its place.
  useEffect(() => {
    if (!following) return;
    closer.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', keys);

    return () => {
      document.removeEventListener('keydown', keys);
      useCrew.getState().opener?.focus({ preventScroll: true });
    };
  }, [following, close]);

  useEffect(() => {
    if (!runId || !place) return;
    let stopped = false;
    const read = async () => {
      try {
        const [history, timeline] = await Promise.all([
          api.messages(profileId, place),
          api.timeline?.(profileId, place).catch(() => []) ?? [],
        ]);
        if (stopped) return;
        setMessages(history);
        setSteps(timeline.find((item) => item.runId === runId)?.steps ?? []);
        setError('');
      } catch (failure) {
        if (!stopped) {
          setError(failure instanceof Error ? failure.message : 'Could not load this agent.');
        }
      }
    };
    void read();
    const timer = working ? setInterval(() => void read(), 1500) : undefined;

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, profileId, runId, place, working]);

  if (!agent) return null;
  const tier = agent.tier ? tierNames[agent.tier] : undefined;
  const said = messages?.filter((message) => message.role === 'assistant') ?? [];

  return (
    <aside className="crew-drawer" aria-label={agent.name}>
      <header>
        <div className="crew-drawer-title">
          <WorkMark
            working={working}
            failed={agent.status !== 'completed'}
            orb={statusOf(agent).state}
          />
          <h2>{agent.name}</h2>
          <button
            ref={closer}
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <div className="crew-drawer-chips">
          <TierChip tier={agent.tier} />
          {agent.modelSelection && (
            <span className="crew-chip">{modelName(agent.modelSelection)}</span>
          )}
          <span className="crew-chip">{agent.role === 'review' ? 'Review' : 'Execute'}</span>
        </div>
        {tier && agent.tierBy && <p className="crew-why">{reasons[agent.tierBy](tier)}</p>}
      </header>
      <div className="crew-drawer-body">
        <ThoughtLine
          working={working}
          label={nowOf(agent)}
          doneLabel={agent.status === 'completed' ? 'Finished in' : 'Stopped after'}
          failed={!working && agent.status !== 'completed'}
          orb={statusOf(agent).state}
          steps={traceOf(steps)}
          startedAt={agent.createdAt}
          finishedAt={working ? undefined : agent.updatedAt}
        />
        {error && <p className="text-bad">{error}</p>}
        {said.map((message) => (
          <ChatMessage key={message.id} message={message} group={false} people={new Map()} opensRun>
            {api.media && (
              <MessageMedia
                api={{ media: api.media }}
                profileId={profileId}
                content={message.content}
              />
            )}
          </ChatMessage>
        ))}
        {!said.length && agent.output && <p className="crew-output">{agent.output}</p>}
        {agent.error && <p className="text-bad">{agent.error}</p>}
      </div>
    </aside>
  );
}
